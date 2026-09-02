import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupProjects,
  copyGitProject,
  copyProject,
  FIXTURE_IMAGES,
  initGitRepo,
  runCli,
} from '../helpers/project.js';
import { snapshotDirs, snapshotTree } from '../helpers/snapshot.js';

afterAll(cleanupProjects);

const CONFIG = '.rasterwright.yml';

/** Every fixture project, so the heuristic meets every corpus the repo has. */
const PROJECTS = [
  'autoorient',
  'budget',
  'clean',
  'collisions',
  'conversion',
  'corrupt',
  'crossrule',
  'depth',
  'maxheight',
  'mixed',
  'overlapping',
  'warnings-only',
];

/** A fixture copy with its committed config removed, so `init` writes the real name. */
function blankProject(name: string, git = false): string {
  const root = git ? copyGitProject(name) : copyProject(name);
  fs.rmSync(path.join(root, CONFIG), { force: true });
  return root;
}

function predictedCounts(stderr: string): { errors: number; warnings: number } {
  const match = /would report (\d+) errors? and (\d+) warnings?/.exec(stderr);
  if (match === null) throw new Error(`no prediction in stderr:\n${stderr}`);
  return { errors: Number(match[1]), warnings: Number(match[2]) };
}

describe('init writes a config that works', () => {
  it.each(PROJECTS)('generates a loadable config for the %s project', async (project) => {
    const root = blankProject(project);

    const init = await runCli(['init'], root);
    expect(init.code).toBe(0);
    expect(init.stdout.trim()).toBe(path.join(root, CONFIG));
    expect(fs.existsSync(path.join(root, CONFIG))).toBe(true);

    const check = await runCli(['check', '--json'], root);
    // A loadable config is the point: exit 2 would mean the parser rejected it.
    expect(check.code).not.toBe(2);

    const report = JSON.parse(check.stdout) as { summary: { errors: number; warnings: number } };
    expect(report.summary).toMatchObject(predictedCounts(init.stderr));
  });

  it('predicts the violation count exactly, corrupt images included', async () => {
    const root = blankProject('corrupt');

    const init = await runCli(['init'], root);
    const check = await runCli(['check', '--json'], root);
    const report = JSON.parse(check.stdout) as { summary: { errors: number; unreadable: number } };

    expect(report.summary.unreadable).toBeGreaterThan(0);
    expect(predictedCounts(init.stderr).errors).toBe(report.summary.errors);
  });

  it('names each rule it wrote, with its size and how many files it flags', async () => {
    const root = blankProject('mixed');
    const init = await runCli(['init'], root);

    expect(init.stderr).toContain('assets/**/*.{jpg,jpeg,png,webp}');
    expect(init.stderr).toMatch(/\d+ images, maxWidth \d+, maxBytes \S+, \d+ over those limits today/);
    expect(init.stderr).toContain('next: run `rasterwright check`');
  });

  it('reports images that no generated rule governs', async () => {
    const root = blankProject('mixed');
    const init = await runCli(['init'], root);
    expect(init.stderr).toMatch(/matched no rule and (is|are) not governed/);
  });
});

describe('init refuses to clobber', () => {
  it('refuses when a config already exists, and writes nothing', async () => {
    const root = copyProject('mixed');
    const before = snapshotTree(root);

    const result = await runCli(['init'], root);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('already exists');
    expect(result.stderr).toContain('--force');
    expect(snapshotTree(root)).toEqual(before);
  });

  // `findConfig` tries .yml first and .yaml second, so only one direction is a
  // config nothing would ever read.
  it('refuses to write .rasterwright.yaml beside an existing .rasterwright.yml', async () => {
    const root = copyProject('mixed');
    const before = snapshotTree(root);

    const result = await runCli(['init', '--config', '.rasterwright.yaml'], root);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('loads it in preference to');
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, '.rasterwright.yaml'))).toBe(false);
  });

  it('writes .rasterwright.yml beside an existing .rasterwright.yaml, and says it wins', async () => {
    const root = blankProject('mixed');
    fs.writeFileSync(path.join(root, '.rasterwright.yaml'), 'version: 1\nrules:\n  "assets/**": {}\n');

    const result = await runCli(['init'], root);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('takes precedence and will be the one loaded');
    expect(fs.existsSync(path.join(root, CONFIG))).toBe(true);
  });

  it('warns that a forced .yaml will still not be read', async () => {
    const root = copyProject('mixed');

    const result = await runCli(['init', '--config', '.rasterwright.yaml', '--force'], root);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('still exists and takes precedence');
  });

  it('overwrites with --force', async () => {
    const root = copyProject('mixed');
    const original = fs.readFileSync(path.join(root, CONFIG), 'utf8');

    const result = await runCli(['init', '--force'], root);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(root, CONFIG), 'utf8')).not.toBe(original);
  });

  it('notes a default-named config when writing somewhere else', async () => {
    const root = copyProject('mixed');

    const result = await runCli(['init', '--config', 'other.yml'], root);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('will load that one');
  });

  it('refuses a target directory that does not exist, rather than creating it', async () => {
    const root = blankProject('mixed');

    const result = await runCli(['init', '--config', 'nope/here.yml'], root);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('not an existing directory');
    expect(fs.existsSync(path.join(root, 'nope'))).toBe(false);
  });
});

describe('init --bare', () => {
  it('writes the template without measuring anything', async () => {
    const root = blankProject('mixed');

    const result = await runCli(['init', '--bare'], root);
    const text = fs.readFileSync(path.join(root, CONFIG), 'utf8');

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('--bare scans nothing');
    expect(result.stderr).not.toContain('would report');
    // The mixed project's own images would produce different numbers, so these
    // constants prove the scan did not run rather than merely that it agreed.
    expect(text).toContain('maxWidth: 2400');
    expect(text).toContain('maxBytes: 500kb');
    expect(text).toContain('assets/**/*.{jpg,jpeg,png,webp}');
  });

  it('falls back to the template when a project holds no images', async () => {
    const root = blankProject('broken-config');

    const result = await runCli(['init'], root);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('found no images to measure');
    expect(fs.readFileSync(path.join(root, CONFIG), 'utf8')).toContain('maxWidth: 2400');
  });
});

describe('init --config', () => {
  it('writes to the given path and treats its directory as the root', async () => {
    const root = blankProject('mixed');
    fs.mkdirSync(path.join(root, 'assets', 'nested'), { recursive: true });

    const result = await runCli(['init', '--config', 'assets/policy.yml'], root);
    const text = fs.readFileSync(path.join(root, 'assets', 'policy.yml'), 'utf8');

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(path.join(root, 'assets', 'policy.yml'));
    // Globs are relative to the config, so they must not be prefixed with assets/.
    expect(text).not.toContain('"assets/');
    expect((await runCli(['check', '--config', 'assets/policy.yml'], root)).code).not.toBe(2);
  });
});

describe('init and .gitignore', () => {
  it('adds the entry inside a git work tree', async () => {
    const root = blankProject('mixed', true);

    const result = await runCli(['init'], root);
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

    expect(result.stderr).toContain('added .rasterwright/ to .gitignore');
    expect(ignore).toContain('.rasterwright/');
    expect(ignore.endsWith('\n')).toBe(true);
  });

  it('does not add it twice', async () => {
    const root = blankProject('mixed', true);

    await runCli(['init'], root);
    const afterFirst = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const second = await runCli(['init', '--force'], root);

    expect(second.stderr).toContain('already ignored');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(afterFirst);
  });

  it('leaves an existing .gitignore alone when a rule already covers it', async () => {
    const root = blankProject('mixed');
    fs.writeFileSync(path.join(root, '.gitignore'), '# mine\n.rasterwright/\n');
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });

    const result = await runCli(['init'], root);

    expect(result.stderr).toContain('already ignored');
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('# mine\n.rasterwright/\n');
  });

  it('appends cleanly to a file with no trailing newline', async () => {
    const root = blankProject('mixed', true);
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist');

    await runCli(['init'], root);
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

    expect(ignore.startsWith('dist\n')).toBe(true);
    expect(ignore).toContain('\n.rasterwright/\n');
    expect(ignore).not.toContain('dist#');
  });

  it('keeps CRLF line endings in a file that already uses them', async () => {
    const root = blankProject('mixed', true);
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist\r\nbuild\r\n');

    await runCli(['init'], root);
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

    expect(ignore.startsWith('dist\r\nbuild\r\n')).toBe(true);
    expect(ignore).toContain('\r\n.rasterwright/\r\n');
    // Not one stray LF anywhere: a mixed-ending file is a whole-file diff.
    expect(/[^\r]\n/.test(ignore)).toBe(false);
  });

  it('appends CRLF to a CRLF file with no trailing newline', async () => {
    const root = blankProject('mixed', true);
    fs.writeFileSync(path.join(root, '.gitignore'), 'dist\r\nbuild');

    await runCli(['init'], root);
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

    expect(ignore.startsWith('dist\r\nbuild\r\n\r\n')).toBe(true);
    expect(/[^\r]\n/.test(ignore)).toBe(false);
  });

  it('uses LF for a new file, and for a file that is mostly LF', async () => {
    const root = blankProject('mixed', true);
    fs.writeFileSync(path.join(root, '.gitignore'), 'a\nb\nc\r\n');

    await runCli(['init'], root);
    const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');

    expect(ignore).toContain('\n.rasterwright/\n');
    expect(ignore).not.toContain('\r\n.rasterwright/');
  });

  it('writes no .gitignore outside a git work tree', async () => {
    const root = blankProject('mixed');

    const result = await runCli(['init'], root);

    expect(result.stderr).toContain('not a git work tree');
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  it('leaves .gitignore alone with --keep-gitignore', async () => {
    const root = blankProject('mixed', true);

    const result = await runCli(['init', '--keep-gitignore'], root);

    expect(result.stderr).toContain('--keep-gitignore');
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });
});

describe('init touches nothing else', () => {
  it('writes exactly one file outside a git repository', async () => {
    const root = blankProject('mixed');
    const before = snapshotTree(root);
    const dirsBefore = snapshotDirs(root);

    await runCli(['init'], root);

    const after = snapshotTree(root);
    const added = after.filter((file) => !before.some((old) => old.path === file.path));
    expect(added.map((file) => file.path)).toEqual([CONFIG]);
    expect(after.filter((file) => file.path !== CONFIG)).toEqual(before);
    expect(snapshotDirs(root)).toEqual(dirsBefore);
  });

  it('writes only the config and .gitignore inside a git repository', async () => {
    const root = blankProject('mixed', true);
    const before = snapshotTree(root);

    await runCli(['init'], root);

    const after = snapshotTree(root);
    const added = after.filter((file) => !before.some((old) => old.path === file.path));
    expect(added.map((file) => file.path).sort()).toEqual(['.gitignore', CONFIG]);
    expect(after.filter((file) => file.path !== CONFIG && file.path !== '.gitignore')).toEqual(before);
  });

  it('creates no .rasterwright directory', async () => {
    const root = blankProject('mixed');
    await runCli(['init'], root);
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(false);
  });

  it('leaves the tree untouched when it refuses', async () => {
    const root = copyProject('mixed');
    const before = snapshotTree(root);
    const dirsBefore = snapshotDirs(root);

    await runCli(['init'], root);

    expect(snapshotTree(root)).toEqual(before);
    expect(snapshotDirs(root)).toEqual(dirsBefore);
  });

  it('is deterministic: two runs over the same corpus produce identical text', async () => {
    const first = blankProject('budget');
    const second = blankProject('budget');

    await runCli(['init'], first);
    await runCli(['init'], second);

    expect(fs.readFileSync(path.join(first, CONFIG), 'utf8')).toBe(
      fs.readFileSync(path.join(second, CONFIG), 'utf8'),
    );
  });
});

describe('init governs the files it measured', () => {
  /** Put three real images into `<root>/<dir>` under the given names. */
  function plant(root: string, dir: string, names: string[]): void {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const name of names) {
      fs.copyFileSync(path.join(FIXTURE_IMAGES, 'compliant.jpg'), path.join(root, dir, name));
    }
  }

  /** Paths `check` inspected, which is the set the generated rules govern. */
  async function governedPaths(root: string): Promise<string[]> {
    const check = await runCli(['check', '--json'], root);
    const report = JSON.parse(check.stdout) as { files: Array<{ path: string }> };
    return report.files.map((file) => file.path).sort();
  }

  it('governs uppercase extensions, which a lowercase-only group would miss', async () => {
    const root = blankProject('clean');
    fs.rmSync(path.join(root, 'assets'), { recursive: true });
    plant(root, 'pics', ['x1.JPG', 'x2.jpg', 'x3.PNG']);

    const init = await runCli(['init'], root);
    const text = fs.readFileSync(path.join(root, CONFIG), 'utf8');

    expect(init.stderr).toContain('scanned 3 images');
    expect(init.stderr).not.toContain('matched no rule');
    expect(text).toContain('JPG');
    expect(await governedPaths(root)).toEqual(['pics/x1.JPG', 'pics/x2.jpg', 'pics/x3.PNG']);
  });

  it('governs a directory whose name is also glob syntax', async () => {
    const root = blankProject('clean');
    fs.rmSync(path.join(root, 'assets'), { recursive: true });
    plant(root, 'img (old) [v2]', ['a.jpg', 'b.jpg', 'c.jpg']);

    const init = await runCli(['init'], root);

    expect(init.stderr).not.toContain('matched no rule');
    expect(await governedPaths(root)).toEqual([
      'img (old) [v2]/a.jpg',
      'img (old) [v2]/b.jpg',
      'img (old) [v2]/c.jpg',
    ]);
  });

  it('governs a directory name containing a quote', async () => {
    const root = blankProject('clean');
    fs.rmSync(path.join(root, 'assets'), { recursive: true });
    plant(root, "say 'hi' \"there\"", ['a.jpg', 'b.jpg', 'c.jpg']);

    await runCli(['init'], root);

    expect(await governedPaths(root)).toHaveLength(3);
  });
});

describe('init and git-ignored images', () => {
  /** A repository where nothing is committed, so ignore rules actually apply. */
  function uncommittedRepo(): string {
    const root = blankProject('mixed');
    initGitRepo(root, { commit: false });
    fs.writeFileSync(path.join(root, '.gitignore'), 'assets/\n');
    return root;
  }

  function scanned(stderr: string): number {
    const match = /scanned (\d+) images?/.exec(stderr);
    if (match === null) throw new Error(`no scan line in stderr:\n${stderr}`);
    return Number(match[1]);
  }

  it('reports how many images the gitignore filter removed', async () => {
    const result = await runCli(['init'], uncommittedRepo());

    expect(result.stderr).toMatch(/skipped by \.gitignore/);
  });

  it('measures git-ignored images with --no-gitignore', async () => {
    const filtered = await runCli(['init'], uncommittedRepo());
    const unfiltered = await runCli(['init', '--no-gitignore'], uncommittedRepo());

    expect(scanned(unfiltered.stderr)).toBeGreaterThan(scanned(filtered.stderr));
    expect(unfiltered.stderr).not.toContain('skipped by .gitignore');
  });
});
