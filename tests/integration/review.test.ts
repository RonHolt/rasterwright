import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupProjects,
  copyGitProject,
  copyProject,
  hashTree,
  initGitRepo,
  residue,
  runCli,
} from '../helpers/project.js';
import { snapshotDirs, snapshotTree } from '../helpers/snapshot.js';
import type { FixReport, ReviewManifest } from '../../src/types.js';

afterAll(cleanupProjects);

/**
 * `fix` retaining review data, and `rasterwright review` turning it into a page.
 *
 * Every test runs the real CLI against a copy of a fixture project, because the
 * properties worth proving are properties of the whole command: what is left on
 * disk, what a second run does to it, and what the page actually references.
 *
 * `CI` is set on every invocation so no test ever spawns a browser. The opener
 * is unit-tested separately, and a detached `xdg-open` on a build machine is a
 * process nobody would ever close.
 */
const NO_BROWSER = { CI: '1' };

function reviewDir(root: string): string {
  return path.join(root, '.rasterwright', 'review');
}

function readManifest(root: string): ReviewManifest {
  return JSON.parse(fs.readFileSync(path.join(reviewDir(root), 'manifest.json'), 'utf8')) as ReviewManifest;
}

function beforeCopies(root: string): string[] {
  const directory = path.join(reviewDir(root), 'before');
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

/**
 * Leftover manifest temp files.
 *
 * The shared `residue` helper skips `.rasterwright` entirely, so the atomic
 * manifest write needs its own assertion: a `.manifest-<pid>-<rand>.json` left
 * behind means a write failed and did not clean up after itself.
 */
function manifestResidue(root: string): string[] {
  const directory = reviewDir(root);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.startsWith('.manifest-')).sort();
}

describe('fix retains what review needs', () => {
  it('copies every original it wrote, and nothing else', async () => {
    const root = copyGitProject('mixed');
    const before = hashTree(root);

    const result = await runCli(['fix', '--allow-renames', '--json'], root, NO_BROWSER);
    const report = JSON.parse(result.stdout) as FixReport;

    expect(report.reviewRecorded).toBe(true);
    const fixed = report.results.filter((entry) => entry.status === 'fixed');
    expect(fixed).toHaveLength(6);

    // One copy per written file, named for the sha256 of the original bytes.
    const copies = beforeCopies(root);
    expect(copies).toHaveLength(6);
    for (const name of copies) expect(name).toMatch(/^[0-9a-f]{64}\.(jpe?g|png|webp)$/);

    // And the copies are the originals, byte for byte.
    for (const entry of fixed) {
      expect(entry.beforeFile).toBeDefined();
      const copy = fs.readFileSync(path.join(reviewDir(root), entry.beforeFile as string));
      const hash = [...before].find(([file]) => file === entry.path)?.[1];
      expect(createHash('sha256').update(copy).digest('hex')).toBe(hash);
    }

    // Nothing was copied for the file the run refused to touch.
    const skipped = report.results.find((entry) => entry.status === 'skipped');
    expect(skipped?.beforeFile).toBeUndefined();
    expect(residue(root)).toEqual([]);
    expect(manifestResidue(root)).toEqual([]);
  });

  it('records one run, with an entry for every exception as well', async () => {
    const root = copyGitProject('mixed');
    await runCli(['fix', '--allow-renames'], root, NO_BROWSER);

    const manifest = readManifest(root);
    expect(manifest.version).toBe(1);
    expect(manifest.retain).toBe(1);
    expect(manifest.runs).toHaveLength(1);

    const run = manifest.runs[0];
    expect(run?.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run?.engine.sharp).toMatch(/^\d+\.\d+\.\d+/);
    expect(run?.permissions).toEqual({ allowRenames: true });
    expect(run?.interrupted).toBe(false);

    const entries = run?.entries ?? [];
    expect(entries.filter((entry) => entry.status === 'fixed')).toHaveLength(6);
    // The skipped transparency conflict is recorded too, so the page can show it.
    const logo = entries.find((entry) => entry.path === 'assets/icons/logo.png');
    expect(logo?.status).toBe('skipped');
    expect(logo?.reason).toMatch(/transparency/);
    expect(logo?.beforeFile).toBeUndefined();

    // Every written entry carries the hash of what was written, which is what
    // lets `review` notice a later edit.
    for (const entry of entries.filter((item) => item.status === 'fixed')) {
      expect(entry.after?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('points the fix summary at the review command', async () => {
    const root = copyGitProject('mixed');
    const result = await runCli(['fix', '--allow-renames'], root, NO_BROWSER);
    expect(result.stdout).toMatch(/Run `rasterwright review`/);
  });

  it('suggests a .gitignore line and never writes one', async () => {
    const root = copyGitProject('maxheight');
    const result = await runCli(['fix'], root, NO_BROWSER);

    expect(result.stderr).toMatch(/is not ignored by git/);
    expect(result.stderr).toMatch(/add `\.rasterwright\/` to \.gitignore/);
    expect(fs.existsSync(path.join(root, '.gitignore'))).toBe(false);
  });
});

describe('fix --no-review', () => {
  it('fixes the images and creates no .rasterwright at all', async () => {
    const root = copyGitProject('mixed');
    const result = await runCli(['fix', '--allow-renames', '--no-review', '--json'], root, NO_BROWSER);
    const report = JSON.parse(result.stdout) as FixReport;

    expect(report.summary.fixed).toBe(6);
    expect(report.reviewRecorded).toBe(false);
    expect(report.results.every((entry) => entry.beforeFile === undefined)).toBe(true);
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(false);
    expect(result.stdout).not.toMatch(/Run `rasterwright review`/);
  });
});

describe('fix and an unusable .rasterwright', () => {
  /**
   * Every level of the review path is checked before anything is written.
   *
   * An obstruction at any of the three makes every before-copy in the run fail
   * the same way, so the run refuses once, up front, having changed nothing -
   * rather than failing image after image with an errno.
   */
  const obstructions: [string, string[]][] = [
    ['.rasterwright itself', ['.rasterwright']],
    ['.rasterwright/review', ['.rasterwright', 'review']],
    ['the before/ store', ['.rasterwright', 'review', 'before']],
  ];

  for (const [what, parts] of obstructions) {
    it(`refuses up front when ${what} is a regular file, and writes nothing`, async () => {
      const root = copyGitProject('maxheight');
      const target = path.join(root, ...parts);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'in the way');
      const files = snapshotTree(root);
      const dirs = snapshotDirs(root);

      const result = await runCli(['fix'], root, NO_BROWSER);

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/exists and is not a directory/);
      expect(result.stderr).toMatch(/--no-review/);
      expect(snapshotTree(root)).toEqual(files);
      expect(snapshotDirs(root)).toEqual(dirs);
    });
  }

  it('refuses a symlink even when it points at a real directory', async () => {
    // Rasterwright writes copies here and later deletes unreferenced ones. A
    // link makes both happen somewhere the path does not name.
    const root = copyGitProject('maxheight');
    const elsewhere = path.join(root, '..', path.basename(root) + '-store');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, '.rasterwright'));

    const result = await runCli(['fix'], root, NO_BROWSER);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/is a symlink/);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('runs anyway with --no-review', async () => {
    const root = copyGitProject('maxheight');
    fs.writeFileSync(path.join(root, '.rasterwright'), 'in the way');

    const result = await runCli(['fix', '--no-review'], root, NO_BROWSER);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/1 file fixed/);
  });

  it('fails the file, with the original intact, when a copy cannot be written', async () => {
    // Past the up-front check: the directories are real, and the copy itself
    // cannot be created because the store is not writable.
    const root = copyGitProject('maxheight');
    const store = path.join(reviewDir(root), 'before');
    fs.mkdirSync(store, { recursive: true });
    fs.chmodSync(store, 0o500);
    const before = hashTree(root);

    try {
      const result = await runCli(['fix', '--json'], root, NO_BROWSER);
      const report = JSON.parse(result.stdout) as FixReport;

      expect(result.code).toBe(1);
      expect(report.summary.failed).toBe(1);
      expect(report.summary.fixed).toBe(0);
      expect(report.results[0]?.reason).toMatch(/could not keep a copy of the original/);
      expect(report.results[0]?.reason).toMatch(/--no-review/);
      // The whole point: the image was left exactly as it was.
      expect(hashTree(root)).toEqual(before);
      expect(residue(root)).toEqual([]);
    } finally {
      fs.chmodSync(store, 0o700);
    }
  });
});

describe('a second, idempotent fix', () => {
  it('leaves the review directory byte-identical and adds no copies', async () => {
    const root = copyGitProject('conversion');
    expect((await runCli(['fix', '--allow-renames'], root, NO_BROWSER)).code).toBe(0);

    const store = hashTree(path.join(root, '.rasterwright'));
    const copies = beforeCopies(root);
    expect(copies.length).toBeGreaterThan(0);

    const second = await runCli(['fix', '--allow-renames', '--json'], root, NO_BROWSER);
    const report = JSON.parse(second.stdout) as FixReport;

    expect(report.results).toEqual([]);
    expect(report.reviewRecorded).toBe(false);
    expect(hashTree(path.join(root, '.rasterwright'))).toEqual(store);
    expect(beforeCopies(root)).toEqual(copies);
    expect(manifestResidue(root)).toEqual([]);
  });

  it('records nothing even when files remain permanently unfixable', async () => {
    // `mixed` can never reach a clean check: `icons/logo.png` is skipped on
    // every run. Recording that as a run would prune away the run that actually
    // changed something and collect its copies.
    const root = copyGitProject('mixed');
    await runCli(['fix', '--allow-renames'], root, NO_BROWSER);
    const store = hashTree(path.join(root, '.rasterwright'));
    const firstRunId = readManifest(root).runs[0]?.runId;

    const second = await runCli(['fix', '--allow-renames', '--json'], root, NO_BROWSER);
    const report = JSON.parse(second.stdout) as FixReport;

    expect(report.summary.skipped).toBe(1);
    expect(report.reviewRecorded).toBe(false);
    expect(hashTree(path.join(root, '.rasterwright'))).toEqual(store);
    expect(readManifest(root).runs[0]?.runId).toBe(firstRunId);
  });
});

describe('check and fix --dry-run still create nothing', () => {
  it('leaves no .rasterwright behind either way', async () => {
    const root = copyProject('mixed');

    await runCli(['check'], root, NO_BROWSER);
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(false);

    await runCli(['fix', '--dry-run', '--allow-renames'], root, NO_BROWSER);
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(false);
  });
});

describe('rasterwright review', () => {
  async function fixed(project = 'mixed'): Promise<string> {
    const root = copyGitProject(project);
    await runCli(['fix', '--allow-renames'], root, NO_BROWSER);
    return root;
  }

  it('renders a page that references files which actually exist', async () => {
    const root = await fixed();
    const result = await runCli(['review', '--no-open'], root, NO_BROWSER);

    expect(result.code).toBe(0);
    const index = path.join(reviewDir(root), 'index.html');
    expect(result.stdout).toContain(index);

    const html = fs.readFileSync(index, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/Needs attention/);
    expect(html).toMatch(/All changes/);
    expect(html).toMatch(/assets\/icons\/logo\.png/);
    expect(html).toMatch(/assets\/heroes\/hero\.webp/);

    // Every image the page points at resolves to a real file on disk.
    const sources = [...html.matchAll(/ src="([^"]+)"/g)].map((match) => match[1] as string);
    expect(sources.length).toBeGreaterThan(5);
    for (const source of sources) {
      const target = path.resolve(reviewDir(root), decodeURIComponent(source.replace(/&amp;/g, '&')));
      expect(fs.existsSync(target), `${source} does not resolve`).toBe(true);
    }
  });

  it('prints the path and opens nothing with --no-open', async () => {
    const root = await fixed();
    const result = await runCli(['review', '--no-open'], root, NO_BROWSER);

    expect(result.stdout.split('\n')[0]).toBe(path.join(reviewDir(root), 'index.html'));
    expect(result.stdout).toMatch(/Open the path above in a browser/);
    expect(result.stdout).toMatch(/retained originals/);
  });

  it('says so clearly, and exits 0, when no run has been recorded', async () => {
    const root = copyGitProject('mixed');
    const result = await runCli(['review', '--no-open'], root, NO_BROWSER);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/no fix run has been recorded/);
    expect(result.stdout.trim()).toBe('');
    // Nothing to render means nothing created.
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(false);
  });

  it('notes an output that changed after the run instead of claiming it', async () => {
    const root = await fixed('maxheight');
    fs.appendFileSync(path.join(root, 'assets', 'tall.png'), Buffer.alloc(8));

    await runCli(['review', '--no-open'], root, NO_BROWSER);
    const html = fs.readFileSync(path.join(reviewDir(root), 'index.html'), 'utf8');

    expect(html).toMatch(/This file has changed since the run/);
  });

  it('notes an output that has gone', async () => {
    const root = await fixed('maxheight');
    fs.rmSync(path.join(root, 'assets', 'tall.png'));

    await runCli(['review', '--no-open'], root, NO_BROWSER);
    const html = fs.readFileSync(path.join(reviewDir(root), 'index.html'), 'utf8');

    expect(html).toMatch(/no longer at/);
  });

  it('is idempotent apart from its own timestamp', async () => {
    const root = await fixed('maxheight');
    await runCli(['review', '--no-open'], root, NO_BROWSER);
    const manifest = fs.readFileSync(path.join(reviewDir(root), 'manifest.json'), 'utf8');
    const copies = beforeCopies(root);

    await runCli(['review', '--no-open'], root, NO_BROWSER);

    // Rendering does not touch the manifest or the store.
    expect(fs.readFileSync(path.join(reviewDir(root), 'manifest.json'), 'utf8')).toBe(manifest);
    expect(beforeCopies(root)).toEqual(copies);
  });
});

describe('review retention', () => {
  /**
   * Three runs over one project, each one changing something.
   *
   * `maxheight` fixes one file and is then compliant, so the second and third
   * runs need a fresh violation to have anything to do. Re-copying the fixture
   * image is what produces one.
   */
  async function threeRuns(): Promise<string> {
    const root = copyProject('maxheight');
    initGitRepo(root);
    const original = fs.readFileSync(path.join(root, 'assets', 'tall.png'));

    for (let run = 0; run < 3; run += 1) {
      if (run > 0) fs.writeFileSync(path.join(root, 'assets', 'tall.png'), original);
      const result = await runCli(['fix'], root, NO_BROWSER);
      expect(result.code, `run ${run} failed`).toBe(0);
    }

    return root;
  }

  it('keeps one run by default and collects the copies the dropped runs held', async () => {
    const root = await threeRuns();

    const manifest = readManifest(root);
    expect(manifest.retain).toBe(1);
    expect(manifest.runs).toHaveLength(1);
    // Every run overwrote the same original bytes, so there is one copy, and it
    // is the one the surviving run refers to.
    expect(beforeCopies(root)).toEqual([
      path.posix.basename(manifest.runs[0]?.entries[0]?.beforeFile as string),
    ]);
  });

  it('persists --keep, so the next runs actually accumulate', async () => {
    const root = copyProject('maxheight');
    initGitRepo(root);
    const original = fs.readFileSync(path.join(root, 'assets', 'tall.png'));

    await runCli(['fix'], root, NO_BROWSER);
    await runCli(['review', '--keep', '2', '--no-open'], root, NO_BROWSER);
    expect(readManifest(root).retain).toBe(2);

    fs.writeFileSync(path.join(root, 'assets', 'tall.png'), original);
    await runCli(['fix'], root, NO_BROWSER);
    fs.writeFileSync(path.join(root, 'assets', 'tall.png'), original);
    await runCli(['fix'], root, NO_BROWSER);

    const manifest = readManifest(root);
    expect(manifest.retain).toBe(2);
    expect(manifest.runs).toHaveLength(2);
  });

  it('collects orphaned copies when --keep drops a run', async () => {
    const root = copyProject('maxheight');
    initGitRepo(root);
    await runCli(['fix'], root, NO_BROWSER);

    // A copy nothing refers to, hash-named so it is Rasterwright's to remove.
    const orphan = `${'f'.repeat(64)}.png`;
    fs.writeFileSync(path.join(reviewDir(root), 'before', orphan), 'orphan');
    // And one that is not, which must survive untouched.
    fs.writeFileSync(path.join(reviewDir(root), 'before', 'notes.txt'), 'mine');

    const result = await runCli(['review', '--keep', '1', '--no-open'], root, NO_BROWSER);

    expect(result.stdout).toMatch(/1 unreferenced copy removed/);
    expect(beforeCopies(root)).not.toContain(orphan);
    expect(beforeCopies(root)).toContain('notes.txt');
    expect(manifestResidue(root)).toEqual([]);
  });

  it('refuses --clean and --keep together rather than picking one', async () => {
    const root = copyGitProject('maxheight');
    await runCli(['fix'], root, NO_BROWSER);

    const result = await runCli(['review', '--clean', '--keep', '2'], root, NO_BROWSER);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/opposite things/);
    // And it refused rather than half-doing either.
    expect(fs.existsSync(reviewDir(root))).toBe(true);
    expect(readManifest(root).retain).toBe(1);
  });

  it('rejects a --keep that is not a positive integer', async () => {
    const root = copyGitProject('maxheight');
    for (const value of ['0', '-1', '2.5', 'many']) {
      const result = await runCli(['review', '--keep', value, '--no-open'], root, NO_BROWSER);
      expect(result.code, `--keep ${value}`).toBe(2);
      expect(result.stderr).toMatch(/--keep: expected a positive integer/);
    }
  });
});

describe('review --clean', () => {
  it('removes the review directory and leaves the images alone', async () => {
    const root = copyGitProject('maxheight');
    await runCli(['fix'], root, NO_BROWSER);
    expect(fs.existsSync(reviewDir(root))).toBe(true);
    const images = hashTree(root);

    const result = await runCli(['review', '--clean'], root, NO_BROWSER);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Removed /);
    expect(fs.existsSync(reviewDir(root))).toBe(false);
    // `.rasterwright/` itself is Rasterwright's namespace and is not this
    // command's to delete.
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(true);
    expect(hashTree(root)).toEqual(images);
  });

  it('reports honestly when the path was a dangling symlink', async () => {
    // `existsSync` follows the link and calls this "nothing to remove", which
    // is untrue: there was a link, and the command has just unlinked it.
    const root = copyGitProject('maxheight');
    fs.mkdirSync(path.join(root, '.rasterwright'), { recursive: true });
    fs.symlinkSync(path.join(root, 'nowhere'), reviewDir(root));

    const result = await runCli(['review', '--clean'], root, NO_BROWSER);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^Removed /);
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(true);
  });

  it('is a clean no-op when there is nothing to remove', async () => {
    const root = copyGitProject('maxheight');
    const result = await runCli(['review', '--clean'], root, NO_BROWSER);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/no review directory to remove/);
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(false);
  });
});

describe('review and a broken manifest', () => {
  it('refuses rather than silently replacing it', async () => {
    const root = copyGitProject('maxheight');
    await runCli(['fix'], root, NO_BROWSER);
    fs.writeFileSync(path.join(reviewDir(root), 'manifest.json'), '{ truncated');

    const result = await runCli(['review', '--no-open'], root, NO_BROWSER);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/not valid JSON/);
    expect(result.stderr).toMatch(/review --clean/);
    expect(fs.readFileSync(path.join(reviewDir(root), 'manifest.json'), 'utf8')).toBe('{ truncated');
  });

  it('reports it on a later fix without failing the images', async () => {
    const root = copyProject('maxheight');
    initGitRepo(root);
    const original = fs.readFileSync(path.join(root, 'assets', 'tall.png'));
    await runCli(['fix'], root, NO_BROWSER);

    fs.writeFileSync(path.join(reviewDir(root), 'manifest.json'), '{ truncated');
    fs.writeFileSync(path.join(root, 'assets', 'tall.png'), original);
    const result = await runCli(['fix', '--json'], root, NO_BROWSER);
    const report = JSON.parse(result.stdout) as FixReport;

    expect(result.code).toBe(0);
    expect(report.summary.fixed).toBe(1);
    expect(report.reviewRecorded).toBe(false);
    expect(result.stderr).toMatch(/images are fixed, but it was not recorded for review/);
  });
});
