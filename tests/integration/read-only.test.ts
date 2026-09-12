import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { FIXTURE_PROJECTS, cleanupProjects, copyProject, runCli } from '../helpers/project.js';
import { snapshotDirs, snapshotTree } from '../helpers/snapshot.js';

afterAll(cleanupProjects);

/**
 * Every fixture project, read off disk rather than listed here.
 *
 * A hand-written list is a list that goes stale: a fixture added for some other
 * suite would quietly never be checked for read-onlyness, and read-onlyness is
 * the one property that has to hold for all of them. `WHAT_IT_EXERCISES` still
 * has to name each project, so adding a fixture makes this file fail until
 * someone says what it is - but the coverage itself comes from the directory.
 */
const PROJECTS = fs
  .readdirSync(FIXTURE_PROJECTS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** Why each fixture is worth running read-only, in one line. */
const WHAT_IT_EXERCISES: Record<string, string> = {
  autoorient: 'a rule that turns autoOrient off, so a rewrite would have to preserve the flag',
  'broken-config': 'a malformed config, which fails before the scan',
  budget: 'a byte budget, where the plan is a re-encode at a chosen quality',
  clean: 'a project with nothing to report',
  collisions: 'plans that would collide, which is the one step that lstats paths outside the scan',
  conversion: 'a format conversion, the plan most likely to want a rename',
  corrupt: 'an image the decoder rejects',
  crossrule: 'a conversion that moves a file out from under the rule that planned it',
  depth: 'a source too deep to re-encode',
  maxheight: 'a straightforward resize',
  mixed: 'errors, warnings, renames and ungoverned files together',
  overlapping: 'overlapping globs, where a later match overrides one property at a time',
  'warnings-only': 'findings that are all warnings, so nothing is an error',
};

/**
 * The acceptance criterion for this layer.
 *
 * `check` may read files and print output. That is the whole contract. It must
 * not touch image bytes, mtimes, filenames, the config, the gitignore, a cache,
 * a review directory, or any other project file.
 */
async function assertReadOnly(project: string, args: string[]): Promise<void> {
  const root = copyProject(project);

  const filesBefore = snapshotTree(root);
  const dirsBefore = snapshotDirs(root);
  expect(filesBefore.length).toBeGreaterThan(0);

  // Push mtimes into the past so a same-second rewrite could not hide itself
  // behind filesystem timestamp granularity.
  const past = new Date(Date.now() - 60_000);
  for (const file of filesBefore) fs.utimesSync(path.join(root, file.path), past, past);
  const baseline = snapshotTree(root);

  await runCli(args, root);

  expect(snapshotTree(root)).toEqual(baseline);
  expect(snapshotDirs(root)).toEqual(dirsBefore);
}

describe('check is read-only', () => {
  it('covers every fixture project, and every one of them is described', () => {
    // The whole point of deriving the list: if this file is ever out of step
    // with the fixtures directory, that is the failure, not a silent gap.
    expect(PROJECTS.length).toBe(fs.readdirSync(FIXTURE_PROJECTS).length);
    expect(Object.keys(WHAT_IT_EXERCISES).sort()).toEqual(PROJECTS);
  });

  it.each(PROJECTS)('changes nothing in %s', async (project) => {
    await assertReadOnly(project, ['check']);
  });

  it('changes nothing with --json', async () => {
    await assertReadOnly('mixed', ['check', '--json']);
  });

  it('changes nothing with --verbose', async () => {
    await assertReadOnly('mixed', ['check', '--verbose']);
  });

  it('creates no cache or review directory', async () => {
    const root = copyProject('mixed');
    await runCli(['check'], root);
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(false);
    expect(fs.readdirSync(root).sort()).toEqual(['.fixture.json', '.rasterwright.yml', 'assets', 'ungoverned']);
  });

  it('does not rename a file whose extension disagrees with its contents', async () => {
    // The extension check is an error, and errors are still only reported.
    const root = copyProject('mixed');
    const before = snapshotTree(root);
    const result = await runCli(['check'], root);
    expect(result.stdout).toMatch(/File extension does not match/);
    expect(fs.existsSync(path.join(root, 'assets', 'logo-webp.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'assets', 'logo-webp.webp'))).toBe(false);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('leaves the git index and working tree untouched inside a repo', async () => {
    const root = copyProject('mixed');
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'commit', '-qm', 'fixture'], {
      cwd: root,
    });

    const before = snapshotTree(path.join(root, 'assets'));
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });

    await runCli(['check'], root);

    expect(snapshotTree(path.join(root, 'assets'))).toEqual(before);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe(status);
  });
});

/**
 * The acceptance criterion for the planning layer, and it is the same one.
 *
 * `fix --dry-run` decides what Rasterwright *would* do. Deciding is not doing:
 * it runs `check`'s pipeline, plans over the result, and prints. No image byte,
 * no temp file, no cache, no manifest, no backup, no rename - with or without
 * the permission that would authorize a rename.
 *
 * This test exists because "the executor does not exist yet" is not a safety
 * property. It will keep being true after the executor does exist.
 */
describe('fix --dry-run is read-only', () => {
  /**
   * Every fixture, planned both ways.
   *
   * `--allow-renames` is run against all of them rather than only the projects
   * that convert a format today, because which fixture produces a rename is a
   * property of the planner and can change; the promise that planning one
   * writes nothing cannot. `collisions` is the sharpest of these: preflight is
   * the one step that reaches outside the scan, lstatting names a rename would
   * land on, and probing a name must neither create it nor touch its occupant.
   */
  it.each(PROJECTS)('changes nothing in %s, with or without --allow-renames', async (project) => {
    await assertReadOnly(project, ['fix', '--dry-run']);
    await assertReadOnly(project, ['fix', '--dry-run', '--allow-renames']);
  });

  it('changes nothing with --json', async () => {
    await assertReadOnly('mixed', ['fix', '--dry-run', '--json']);
  });

  it('changes nothing with --json and --allow-renames together', async () => {
    await assertReadOnly('mixed', ['fix', '--dry-run', '--json', '--allow-renames']);
  });

  it('changes nothing when a real fix refuses its preconditions', async () => {
    // These projects are copied outside any repository, so `fix` refuses for
    // want of an undo mechanism. A refusal that had already swept a directory
    // or created a backup would not be a refusal, so the same snapshot applies.
    await assertReadOnly('mixed', ['fix']);
    await assertReadOnly('mixed', ['fix', '--allow-renames']);
    await assertReadOnly('mixed', ['fix', '--backup-dir', 'inside-the-project']);
  });

  it('creates no cache, review directory, manifest or backup', async () => {
    const root = copyProject('mixed');
    await runCli(['fix', '--dry-run', '--allow-renames'], root);

    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(false);
    expect(fs.readdirSync(root).sort()).toEqual(['.fixture.json', '.rasterwright.yml', 'assets', 'ungoverned']);
  });

  it('renames nothing, even with permission to plan a rename', async () => {
    const root = copyProject('mixed');
    const before = snapshotTree(root);

    const result = await runCli(['fix', '--dry-run', '--allow-renames'], root);
    expect(result.stdout).toMatch(/rename\s+\.png -> \.webp/);

    expect(fs.existsSync(path.join(root, 'assets', 'logo-webp.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'assets', 'logo-webp.webp'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'assets', 'heroes', 'hero.webp'))).toBe(false);
    expect(snapshotTree(root)).toEqual(before);
  });

  it('leaves the git index and working tree untouched inside a repo', async () => {
    const root = copyProject('mixed');
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', 'commit', '-qm', 'fixture'], {
      cwd: root,
    });

    const before = snapshotTree(path.join(root, 'assets'));
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });

    await runCli(['fix', '--dry-run', '--allow-renames'], root);

    expect(snapshotTree(path.join(root, 'assets'))).toEqual(before);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe(status);
  });
});
