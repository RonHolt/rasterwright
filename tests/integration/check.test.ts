import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { cleanupProjects, copyProject, runCli } from '../helpers/project.js';

afterAll(cleanupProjects);

interface JsonReport {
  clean: boolean;
  rasterwrightVersion: string;
  configPath: string;
  root: string;
  summary: {
    checked: number;
    compliant: number;
    violating: number;
    violations: number;
    errors: number;
    ignored: number;
  };
  files: Array<{
    path: string;
    status: string;
    image?: Record<string, unknown>;
    policy?: Record<string, unknown>;
    matchedGlobs: string[];
    violations: Array<{ check: string; actual: unknown; allowed: unknown; fixable: string; rule: string }>;
    notes: Array<{ code: string; message: string }>;
    fixable: string;
    error?: string;
  }>;
  diagnostics: string[];
}

async function checkJson(project: string): Promise<{ code: number; report: JsonReport; stderr: string }> {
  const root = copyProject(project);
  const result = await runCli(['check', '--json'], root);
  return { code: result.code, report: JSON.parse(result.stdout) as JsonReport, stderr: result.stderr };
}

function fileIn(report: JsonReport, relativePath: string) {
  const file = report.files.find((entry) => entry.path === relativePath);
  if (file === undefined) throw new Error(`no result for ${relativePath}; got ${report.files.map((f) => f.path).join(', ')}`);
  return file;
}

describe('exit codes', () => {
  it('exits 0 on a clean project', async () => {
    const root = copyProject('clean');
    const result = await runCli(['check'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No policy violations\./);
    expect(result.stdout).toMatch(/3 images checked/);
  });

  it('exits 1 when there are violations', async () => {
    const root = copyProject('mixed');
    const result = await runCli(['check'], root);
    expect(result.code).toBe(1);
  });

  it('exits 1 when an image cannot be inspected', async () => {
    const root = copyProject('corrupt');
    const result = await runCli(['check'], root);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/could not decode image/);
    expect(result.stdout).toMatch(/1 file could not be inspected/);
    // The batch continues: the healthy file is still reported as compliant.
    expect(result.stdout).toMatch(/1 compliant/);
  });

  it('exits 2 on a malformed config', async () => {
    const root = copyProject('broken-config');
    const result = await runCli(['check'], root);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/is not valid YAML/);
    expect(result.stdout).toBe('');
  });

  it('exits 2 when there is no config', async () => {
    const root = copyProject('clean');
    fs.rmSync(path.join(root, '.rasterwright.yml'));
    const result = await runCli(['check', '--config', 'nowhere.yml'], root);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/config not found/);
  });
});

describe('human output', () => {
  it('lists each violation with actual and allowed values', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);

    expect(stdout).toMatch(/^Rasterwright$/m);
    expect(stdout).toMatch(/✗ assets\/oversized\.jpg/);
    expect(stdout).toMatch(/maxWidth\s+2000 px\s+allowed: 1200 px/);
    expect(stdout).toMatch(/maxBytes\s+457 KB\s+allowed: 200 KB/);
    expect(stdout).toMatch(/format\s+JPEG\s+expected: WebP/);
    expect(stdout).toMatch(/Fixable: yes/);
    expect(stdout).toMatch(/Fixable: no/);
    expect(stdout).toMatch(/Fixable: unknown \(depends on encoding\)/);
    expect(stdout).toMatch(/9 images checked/);
    expect(stdout).toMatch(/6 files with violations/);
    expect(stdout).toMatch(/3 compliant/);
    expect(stdout).toMatch(/1 image matched no rule and was skipped/);
  });

  it('explains why a transparent PNG cannot become a JPEG', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);
    expect(stdout).toMatch(/transparency present, and JPEG cannot represent it/);
  });
});

describe('json output', () => {
  it('puts JSON on stdout and nothing else', async () => {
    const root = copyProject('mixed');
    const result = await runCli(['check', '--json'], root);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    // Diagnostics (such as "gitignore not applied") go to stderr, never stdout.
    expect(result.stdout.startsWith('{')).toBe(true);
  });

  it('has the documented top-level shape', async () => {
    const { code, report } = await checkJson('mixed');
    expect(code).toBe(1);
    expect(report.clean).toBe(false);
    expect(report.rasterwrightVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.summary).toEqual({
      checked: 9,
      compliant: 3,
      violating: 6,
      violations: 7,
      errors: 0,
      ignored: 1,
    });
    expect(report.files).toHaveLength(9);
  });

  it('reports clean: true and exit 0 for a compliant project', async () => {
    const { code, report } = await checkJson('clean');
    expect(code).toBe(0);
    expect(report.clean).toBe(true);
    expect(report.summary).toMatchObject({ checked: 3, compliant: 3, violating: 0, violations: 0, errors: 0 });
  });

  it('includes image info, effective policy, violations and fixability per file', async () => {
    const { report } = await checkJson('mixed');
    const oversized = fileIn(report, 'assets/oversized.jpg');

    expect(oversized.status).toBe('violating');
    expect(oversized.image).toMatchObject({
      path: 'assets/oversized.jpg',
      format: 'jpeg',
      width: 2000,
      height: 1200,
      hasAlpha: false,
      orientation: 1,
      isAnimated: false,
      colorSpaceStatus: 'srgb',
    });
    expect(typeof oversized.image?.contentHash).toBe('string');
    expect(oversized.policy).toMatchObject({ maxWidth: 1200, maxBytes: 204_800, stripMetadata: true });
    expect(oversized.matchedGlobs).toEqual(['assets/**/*.{jpg,jpeg,png,webp}']);
    expect(oversized.violations).toEqual([
      expect.objectContaining({ check: 'maxWidth', actual: 2000, allowed: 1200, fixable: 'yes' }),
    ]);
    expect(oversized.fixable).toBe('yes');
  });

  it('merges overlapping rules into the effective policy it reports', async () => {
    const { report } = await checkJson('mixed');
    const hero = fileIn(report, 'assets/heroes/hero.jpg');

    expect(hero.matchedGlobs).toEqual(['assets/**/*.{jpg,jpeg,png,webp}', 'assets/heroes/**']);
    // maxWidth and maxBytes from the narrower rule, format too, defaults underneath.
    expect(hero.policy).toMatchObject({
      maxWidth: 800,
      maxBytes: 102_400,
      format: 'webp',
      stripMetadata: true,
      colorSpace: 'srgb',
    });
  });

  it('marks an unsafe format conversion as not fixable', async () => {
    const { report } = await checkJson('mixed');
    const logo = fileIn(report, 'assets/icons/logo.png');

    expect(logo.violations).toEqual([
      expect.objectContaining({ check: 'format', actual: 'PNG', allowed: 'JPEG', fixable: 'no' }),
    ]);
    expect(logo.fixable).toBe('no');
    expect(logo.notes.map((note) => note.code)).toContain('transparency');
    expect(logo.image).toMatchObject({ hasAlpha: true, isOpaque: false });
  });

  it('reports an unreadable image as an error, not a violation', async () => {
    const { code, report } = await checkJson('corrupt');
    expect(code).toBe(1);
    expect(report.clean).toBe(false);
    expect(report.summary).toMatchObject({ checked: 2, compliant: 1, violating: 0, errors: 1 });

    const broken = fileIn(report, 'assets/broken.jpg');
    expect(broken.status).toBe('error');
    expect(broken.error).toMatch(/could not decode image/);
    expect(broken.violations).toEqual([]);
    expect(broken.image).toBeUndefined();
  });

  it('silently skips files that match no rule', async () => {
    const { report } = await checkJson('mixed');
    expect(report.summary.ignored).toBe(1);
    expect(report.files.some((file) => file.path === 'ungoverned/stray.png')).toBe(false);
  });

  it('flags a file over maxHeight and leaves a shorter one alone', async () => {
    const { code, report } = await checkJson('maxheight');
    expect(code).toBe(1);
    expect(fileIn(report, 'assets/tall.png').violations).toEqual([
      expect.objectContaining({ check: 'maxHeight', actual: 1400, allowed: 600, fixable: 'yes' }),
    ]);
    expect(fileIn(report, 'assets/short.png').status).toBe('compliant');
  });

  it('applies merged overlapping rules to real files', async () => {
    const { report } = await checkJson('overlapping');
    const tiny = fileIn(report, 'assets/tiny/plain.png');

    expect(tiny.matchedGlobs).toEqual(['assets/**', 'assets/**/*.png', 'assets/tiny/**']);
    // maxWidth from the last match, maxBytes from the middle one.
    expect(tiny.policy).toMatchObject({ maxWidth: 100, maxBytes: 51_200 });
    expect(tiny.violations).toEqual([
      expect.objectContaining({ check: 'maxWidth', actual: 400, allowed: 100, rule: 'assets/tiny/**' }),
    ]);

    const wide = fileIn(report, 'assets/wide.jpg');
    expect(wide.policy).toMatchObject({ maxWidth: 1200, maxBytes: 512_000 });
    expect(wide.status).toBe('compliant');
  });

  it('reports EXIF orientation and metadata on a rotated photo', async () => {
    const { report } = await checkJson('mixed');
    const rotated = fileIn(report, 'assets/rotated.jpg');

    expect(rotated.image).toMatchObject({ orientation: 6, storedWidth: 600, storedHeight: 400, width: 400, height: 600 });
    expect(rotated.violations.map((violation) => violation.check)).toEqual(['metadata', 'orientation']);
  });

  it('reports a CMYK image as non-sRGB', async () => {
    const { report } = await checkJson('mixed');
    expect(fileIn(report, 'assets/cmyk.jpg').violations).toEqual([
      expect.objectContaining({ check: 'colorSpace', actual: 'cmyk', allowed: 'sRGB' }),
    ]);
  });
});

describe('config discovery', () => {
  it('finds the config from a subdirectory', async () => {
    const root = copyProject('mixed');
    const result = await runCli(['check', '--json'], path.join(root, 'assets'));
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.root).toBe(fs.realpathSync(root));
    expect(report.summary.checked).toBe(9);
  });

  it('accepts an explicit --config path', async () => {
    const root = copyProject('clean');
    const result = await runCli(['check', '--config', '.rasterwright.yml'], root);
    expect(result.code).toBe(0);
  });
});
