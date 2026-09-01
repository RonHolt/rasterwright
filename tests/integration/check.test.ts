import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { cleanupProjects, copyProject, runCli } from '../helpers/project.js';

afterAll(cleanupProjects);

interface JsonFinding {
  path: string;
  rule: string;
  check: string;
  severity: 'error' | 'warning' | 'info';
  actual: string | number | null;
  allowed: string | number | null;
  fixable: 'yes' | 'no' | 'unknown' | 'n/a';
  message: string;
}

interface JsonReport {
  clean: boolean;
  rasterwrightVersion: string;
  configPath: string;
  root: string;
  summary: {
    checked: number;
    clean: number;
    withWarnings: number;
    withErrors: number;
    errors: number;
    warnings: number;
    infos: number;
    unreadable: number;
    ignored: number;
  };
  files: Array<{
    path: string;
    status: string;
    image?: Record<string, unknown>;
    policy?: Record<string, unknown>;
    matchedGlobs: string[];
    findings: JsonFinding[];
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
  if (file === undefined) {
    throw new Error(`no result for ${relativePath}; got ${report.files.map((f) => f.path).join(', ')}`);
  }
  return file;
}

function findingIn(report: JsonReport, relativePath: string, check: string): JsonFinding {
  const finding = fileIn(report, relativePath).findings.find((f) => f.check === check);
  if (finding === undefined) throw new Error(`no ${check} finding on ${relativePath}`);
  return finding;
}

describe('exit codes', () => {
  it('exits 0 on a clean project', async () => {
    const root = copyProject('clean');
    const result = await runCli(['check'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/No errors or warnings\./);
    expect(result.stdout).toMatch(/3 images checked/);
  });

  it('exits 0 when the only findings are warnings', async () => {
    const root = copyProject('warnings-only');
    const result = await runCli(['check'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/WARNINGS/);
    expect(result.stdout).toMatch(/2 images contain removable metadata/);
    expect(result.stdout).toMatch(/No errors\./);
    expect(result.stdout).not.toMatch(/ERRORS/);
  });

  it('exits 1 when there are errors', async () => {
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
    // The batch continues: the healthy file is still reported as clean.
    expect(result.stdout).toMatch(/1 clean/);
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
  it('puts errors first, one block each', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);

    expect(stdout).toMatch(/^Rasterwright$/m);
    expect(stdout.indexOf('ERRORS')).toBeLessThan(stdout.indexOf('WARNINGS'));
    expect(stdout).toMatch(/✗ assets\/oversized\.jpg/);
    expect(stdout).toMatch(/maxWidth\s+2000 px\s+allowed: 1200 px/);
    expect(stdout).toMatch(/maxBytes\s+457 KB\s+allowed: 200 KB/);
    expect(stdout).toMatch(/format\s+JPEG\s+expected: WebP/);
  });

  it('says what to do about an unmeetable byte budget instead of shrugging', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);
    expect(stdout).toMatch(/Fix requires encoding/);
    expect(stdout).not.toMatch(/Fixable: unknown/);
  });

  it('explains why a transparent PNG cannot become a JPEG', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);
    expect(stdout).toMatch(/Not safely fixable: transparency present, and JPEG cannot represent it/);
  });

  it('warns that a format conversion will need rename permission', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);
    expect(stdout).toMatch(/--allow-renames/);
  });

  it('shows an extension mismatch as two claims about the same file', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);
    expect(stdout).toMatch(/✗ assets\/logo-webp\.png/);
    expect(stdout).toMatch(/extension\s+PNG/);
    expect(stdout).toMatch(/contents\s+WebP/);
    expect(stdout).toMatch(/File extension does not match the encoded image format\./);
  });

  it('summarizes repetitive warnings instead of listing every file', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);

    expect(stdout).toMatch(/⚠ 3 images contain removable metadata/);
    expect(stdout).toMatch(/2 with EXIF/);
    expect(stdout).toMatch(/1 with XMP/);
    expect(stdout).toMatch(/Run with --verbose to list them\./);
    // The individual warning files do not get their own blocks by default.
    expect(stdout).not.toMatch(/⚠ assets\/exif\.jpg/);
  });

  it('does not narrate ordinary image properties', async () => {
    // Transparency and unused alpha are properties of most PNGs, not findings.
    // Reporting them produced 55 notes on the first real project.
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);
    expect(stdout).not.toMatch(/has meaningful transparency/);
    expect(stdout).not.toMatch(/every pixel is opaque/);
    expect(stdout).not.toMatch(/informational note/);
    // But transparency still speaks up where it changes an answer.
    expect(stdout).toMatch(/Not safely fixable: transparency present/);
  });

  it('totals errors, warnings and clean files', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check'], root);
    expect(stdout).toMatch(/15 images checked/);
    expect(stdout).toMatch(/7 files with errors/);
    expect(stdout).toMatch(/3 files with warnings/);
    expect(stdout).toMatch(/6 clean/);
    expect(stdout).toMatch(/1 image matched no rule and was skipped/);
  });
});

describe('--verbose', () => {
  it('lists every warning file individually', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check', '--verbose'], root);
    expect(stdout).toMatch(/⚠ assets\/exif\.jpg/);
    expect(stdout).toMatch(/⚠ assets\/xmp\.png/);
    expect(stdout).not.toMatch(/Run with --verbose to list them\./);
  });

  it('has no notes section to show when nothing is exceptional', async () => {
    // The fixture project contains transparent, opaque-alpha and profiled
    // images. None of that is noteworthy, so --verbose stays quiet about it.
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check', '--verbose'], root);
    expect(stdout).not.toMatch(/NOTES/);
  });

  it('does not change the exit code', async () => {
    const quiet = copyProject('warnings-only');
    const loud = copyProject('warnings-only');
    expect((await runCli(['check'], quiet)).code).toBe(0);
    expect((await runCli(['check', '--verbose'], loud)).code).toBe(0);
  });

  it('is also available as -v', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['check', '-v'], root);
    expect(stdout).toMatch(/⚠ assets\/exif\.jpg/);
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
      checked: 15,
      clean: 6,
      withWarnings: 3,
      withErrors: 7,
      errors: 7,
      warnings: 3,
      infos: 0,
      unreadable: 0,
      ignored: 1,
    });
    expect(report.files).toHaveLength(15);
  });

  it('stays exhaustive where the human report summarizes', async () => {
    const { report } = await checkJson('mixed');
    // Every warning is present per file, not collapsed into a count.
    const warnings = report.files.flatMap((f) => f.findings.filter((x) => x.severity === 'warning'));
    expect(warnings).toHaveLength(3);
    expect(warnings.map((w) => w.path).sort()).toEqual([
      'assets/exif.jpg',
      'assets/rotated.jpg',
      'assets/xmp.png',
    ]);
  });

  it('keeps alpha detail on ImageInfo even though it is not a finding', async () => {
    // This is where a future fix planner reads it from, and where an agent
    // reading --json can still see it.
    const { report } = await checkJson('mixed');
    expect(fileIn(report, 'assets/icons/logo.png').image).toMatchObject({ hasAlpha: true, isOpaque: false });
    expect(fileIn(report, 'assets/opaque.png').image).toMatchObject({ hasAlpha: true, isOpaque: true });
    expect(fileIn(report, 'assets/compliant.jpg').image).toMatchObject({ hasAlpha: false, isOpaque: null });
  });

  it('reports clean: true with warnings present, and exits 0', async () => {
    const { code, report } = await checkJson('warnings-only');
    expect(code).toBe(0);
    expect(report.clean).toBe(true);
    expect(report.summary).toMatchObject({ checked: 4, clean: 2, withWarnings: 2, withErrors: 0, warnings: 2 });
    expect(findingIn(report, 'assets/exif.jpg', 'metadata')).toMatchObject({
      severity: 'warning',
      actual: 'EXIF',
      fixable: 'yes',
    });
  });

  it('includes image info, effective policy, findings and fixability per file', async () => {
    const { report } = await checkJson('mixed');
    const oversized = fileIn(report, 'assets/oversized.jpg');

    expect(oversized.status).toBe('error');
    expect(oversized.image).toMatchObject({
      path: 'assets/oversized.jpg',
      format: 'jpeg',
      width: 2000,
      height: 1200,
      hasAlpha: false,
      hasExif: false,
      hasXmp: false,
      hasIptc: false,
      hasOtherMetadata: false,
      orientation: 1,
      isAnimated: false,
      colorSpaceStatus: 'srgb',
    });
    expect(typeof oversized.image?.contentHash).toBe('string');
    expect(oversized.policy).toMatchObject({
      maxWidth: 1200,
      maxBytes: 204_800,
      stripMetadata: true,
      autoOrient: true,
    });
    expect(oversized.matchedGlobs).toEqual(['assets/**/*.{jpg,jpeg,png,webp}']);
    expect(oversized.findings).toEqual([
      expect.objectContaining({ check: 'maxWidth', severity: 'error', actual: 2000, allowed: 1200, fixable: 'yes' }),
    ]);
    expect(oversized.fixable).toBe('yes');
  });

  it('keeps maxBytes fixability unknown', async () => {
    const { report } = await checkJson('mixed');
    expect(findingIn(report, 'assets/heavy.jpg', 'maxBytes')).toMatchObject({
      severity: 'error',
      fixable: 'unknown',
    });
    expect(fileIn(report, 'assets/heavy.jpg').fixable).toBe('unknown');
  });

  it('merges overlapping rules into the effective policy it reports', async () => {
    const { report } = await checkJson('mixed');
    const hero = fileIn(report, 'assets/heroes/hero.jpg');

    expect(hero.matchedGlobs).toEqual(['assets/**/*.{jpg,jpeg,png,webp}', 'assets/heroes/**']);
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

    expect(findingIn(report, 'assets/icons/logo.png', 'format')).toMatchObject({
      severity: 'error',
      actual: 'PNG',
      allowed: 'JPEG',
      fixable: 'no',
    });
    expect(logo.fixable).toBe('no');
    expect(logo.findings.map((f) => f.check)).toEqual(['format']);
    expect(logo.image).toMatchObject({ hasAlpha: true, isOpaque: false });
  });

  it('detects a WebP hiding behind a .png extension', async () => {
    const { report } = await checkJson('mixed');
    expect(fileIn(report, 'assets/logo-webp.png').image).toMatchObject({ format: 'webp' });
    expect(findingIn(report, 'assets/logo-webp.png', 'extension')).toMatchObject({
      severity: 'error',
      actual: 'WebP',
      allowed: 'PNG',
      fixable: 'yes',
      rule: '(built-in)',
    });
  });

  it('treats .jpeg as a legitimate alias for .jpg', async () => {
    const { report } = await checkJson('mixed');
    expect(fileIn(report, 'assets/photo.jpeg')).toMatchObject({ status: 'clean', findings: [] });
  });

  it('does not warn about an image whose only metadata is an sRGB profile', async () => {
    const { report } = await checkJson('mixed');
    const tagged = fileIn(report, 'assets/tagged.png');
    expect(tagged.image).toMatchObject({ hasIccProfile: true, iccDescription: 'sRGB', colorSpaceStatus: 'srgb' });
    expect(tagged.status).toBe('clean');
    expect(tagged.findings).toEqual([]);
  });

  it('leaves an image with an unused alpha channel entirely alone', async () => {
    const { report } = await checkJson('mixed');
    const opaque = fileIn(report, 'assets/opaque.png');
    expect(opaque.status).toBe('clean');
    expect(opaque.findings).toEqual([]);
    expect(report.summary.infos).toBe(0);
  });

  it('reports an unreadable image as an error finding', async () => {
    const { code, report } = await checkJson('corrupt');
    expect(code).toBe(1);
    expect(report.clean).toBe(false);
    expect(report.summary).toMatchObject({ checked: 2, clean: 1, withErrors: 1, unreadable: 1 });

    const broken = fileIn(report, 'assets/broken.jpg');
    expect(broken.status).toBe('error');
    expect(broken.error).toMatch(/could not decode image/);
    expect(broken.image).toBeUndefined();
    expect(findingIn(report, 'assets/broken.jpg', 'decode')).toMatchObject({ severity: 'error', fixable: 'no' });
  });

  it('silently skips files that match no rule', async () => {
    const { report } = await checkJson('mixed');
    expect(report.summary.ignored).toBe(1);
    expect(report.files.some((file) => file.path === 'ungoverned/stray.png')).toBe(false);
  });

  it('flags a file over maxHeight and leaves a shorter one alone', async () => {
    const { code, report } = await checkJson('maxheight');
    expect(code).toBe(1);
    expect(findingIn(report, 'assets/tall.png', 'maxHeight')).toMatchObject({
      severity: 'error',
      actual: 1400,
      allowed: 600,
      fixable: 'yes',
    });
    expect(fileIn(report, 'assets/short.png').status).toBe('clean');
  });

  it('applies merged overlapping rules to real files', async () => {
    const { report } = await checkJson('overlapping');
    const tiny = fileIn(report, 'assets/tiny/plain.png');

    expect(tiny.matchedGlobs).toEqual(['assets/**', 'assets/**/*.png', 'assets/tiny/**']);
    // maxWidth from the last match, maxBytes from the middle one.
    expect(tiny.policy).toMatchObject({ maxWidth: 100, maxBytes: 51_200 });
    expect(tiny.findings).toEqual([
      expect.objectContaining({ check: 'maxWidth', actual: 400, allowed: 100, rule: 'assets/tiny/**' }),
    ]);

    const wide = fileIn(report, 'assets/wide.jpg');
    expect(wide.policy).toMatchObject({ maxWidth: 1200, maxBytes: 512_000 });
    expect(wide.status).toBe('clean');
  });

  it('reports EXIF orientation as an error and its EXIF block as a warning', async () => {
    const { report } = await checkJson('mixed');
    const rotated = fileIn(report, 'assets/rotated.jpg');

    expect(rotated.image).toMatchObject({
      orientation: 6,
      storedWidth: 600,
      storedHeight: 400,
      width: 400,
      height: 600,
    });
    expect(rotated.findings.map((f) => [f.check, f.severity])).toEqual([
      ['metadata', 'warning'],
      ['orientation', 'error'],
    ]);
    expect(rotated.status).toBe('error');
  });

  it('reports a CMYK image as non-sRGB', async () => {
    const { report } = await checkJson('mixed');
    expect(findingIn(report, 'assets/cmyk.jpg', 'colorSpace')).toMatchObject({
      severity: 'error',
      actual: 'cmyk',
      allowed: 'sRGB',
    });
  });
});

describe('autoOrient', () => {
  it('errors on a rotated image by default and stays silent when turned off', async () => {
    const { code, report } = await checkJson('autoorient');
    expect(code).toBe(1);

    expect(findingIn(report, 'normalized/rotated.jpg', 'orientation')).toMatchObject({
      severity: 'error',
      actual: 6,
      allowed: 1,
      fixable: 'yes',
    });

    const kept = fileIn(report, 'kept/rotated.jpg');
    expect(kept.status).toBe('clean');
    expect(kept.findings).toEqual([]);
    expect(kept.image).toMatchObject({ orientation: 6 });
  });

  it('resolves autoOrient into the reported effective policy', async () => {
    const { report } = await checkJson('autoorient');
    expect(fileIn(report, 'kept/rotated.jpg').policy).toMatchObject({ autoOrient: false });
    expect(fileIn(report, 'normalized/rotated.jpg').policy).toMatchObject({ autoOrient: true });
  });
});

describe('config discovery', () => {
  it('finds the config from a subdirectory', async () => {
    const root = copyProject('mixed');
    const result = await runCli(['check', '--json'], path.join(root, 'assets'));
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.root).toBe(fs.realpathSync(root));
    expect(report.summary.checked).toBe(15);
    expect(report.summary.clean).toBe(6);
  });

  it('accepts an explicit --config path', async () => {
    const root = copyProject('clean');
    const result = await runCli(['check', '--config', '.rasterwright.yml'], root);
    expect(result.code).toBe(0);
  });
});
