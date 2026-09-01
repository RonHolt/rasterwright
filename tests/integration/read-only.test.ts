import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { cleanupProjects, copyProject, runCli } from '../helpers/project.js';
import { snapshotDirs, snapshotTree } from '../helpers/snapshot.js';

afterAll(cleanupProjects);

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
  it('changes nothing in a project with errors', async () => {
    await assertReadOnly('mixed', ['check']);
  });

  it('changes nothing with --json', async () => {
    await assertReadOnly('mixed', ['check', '--json']);
  });

  it('changes nothing with --verbose', async () => {
    await assertReadOnly('mixed', ['check', '--verbose']);
  });

  it('changes nothing in a project whose findings are all warnings', async () => {
    await assertReadOnly('warnings-only', ['check']);
  });

  it('changes nothing when a rule turns autoOrient off', async () => {
    await assertReadOnly('autoorient', ['check']);
  });

  it('changes nothing in a clean project', async () => {
    await assertReadOnly('clean', ['check']);
  });

  it('changes nothing when an image is corrupt', async () => {
    await assertReadOnly('corrupt', ['check']);
  });

  it('changes nothing when the config is malformed', async () => {
    await assertReadOnly('broken-config', ['check']);
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
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'fixture'], {
      cwd: root,
    });

    const before = snapshotTree(path.join(root, 'assets'));
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });

    await runCli(['check'], root);

    expect(snapshotTree(path.join(root, 'assets'))).toEqual(before);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })).toBe(status);
  });
});
