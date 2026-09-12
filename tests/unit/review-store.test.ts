import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  beforeExtension,
  beforeStoreBytes,
  collectGarbage,
  emptyManifest,
  entriesFrom,
  normalizeRetain,
  pruneRuns,
  readManifest,
  resolveReviewDir,
  retainOriginal,
  reviewDirFor,
  writeManifest,
} from '../../src/review/store.js';
import { RasterwrightError } from '../../src/utils/errors.js';
import { fakeReport, fakeRun } from '../helpers/review.js';
import type { ReviewManifest } from '../../src/types.js';

const dirs: string[] = [];

function scratch(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rasterwright-review-')));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('resolveReviewDir', () => {
  it('creates nothing', () => {
    const root = scratch();
    expect(resolveReviewDir(root)).toBe(reviewDirFor(root));
    expect(fs.existsSync(path.join(root, '.rasterwright'))).toBe(false);
  });

  it('accepts a .rasterwright that is already a directory', () => {
    const root = scratch();
    fs.mkdirSync(path.join(root, '.rasterwright'));
    expect(resolveReviewDir(root)).toBe(reviewDirFor(root));
  });

  it('refuses a .rasterwright that is a regular file, and names the escape hatch', () => {
    const root = scratch();
    fs.writeFileSync(path.join(root, '.rasterwright'), 'not a directory');

    expect(() => resolveReviewDir(root)).toThrow(RasterwrightError);
    try {
      resolveReviewDir(root);
    } catch (error) {
      expect((error as RasterwrightError).message).toMatch(/exists and is not a directory/);
      expect((error as RasterwrightError).hint).toMatch(/--no-review/);
    }
  });
});

describe('beforeExtension', () => {
  it('keeps the source extension, lowercased', () => {
    expect(beforeExtension('assets/a.JPG', 'jpeg')).toBe('.jpg');
    expect(beforeExtension('assets/a.jpeg', 'jpeg')).toBe('.jpeg');
    expect(beforeExtension('assets/a.WebP', 'webp')).toBe('.webp');
  });

  it('falls back to the format when the path cannot supply a usable one', () => {
    // Every stored name has to stay inside what garbage collection recognises,
    // or the copy would be retained forever.
    expect(beforeExtension('assets/logo', 'png')).toBe('.png');
    expect(beforeExtension('assets/logo.bmp', 'jpeg')).toBe('.jpg');
  });
});

describe('retainOriginal', () => {
  it('names the copy for its contents and fsyncs it', async () => {
    const reviewDir = path.join(scratch(), 'review');
    const bytes = Buffer.from('some image bytes');
    const hash = sha256(bytes);

    const name = await retainOriginal(reviewDir, 'assets/hero.jpg', bytes, hash, 'jpeg');

    expect(name).toBe(`before/${hash}.jpg`);
    expect(fs.readFileSync(path.join(reviewDir, name)).equals(bytes)).toBe(true);
  });

  it('treats an existing copy of the same bytes as success', async () => {
    const reviewDir = path.join(scratch(), 'review');
    const bytes = Buffer.from('identical');
    const hash = sha256(bytes);

    const first = await retainOriginal(reviewDir, 'a.png', bytes, hash, 'png');
    const second = await retainOriginal(reviewDir, 'b.png', bytes, hash, 'png');

    expect(second).toBe(first);
    expect(fs.readdirSync(path.join(reviewDir, 'before'))).toHaveLength(1);
  });

  it('fails with a message naming --no-review when the copy cannot be written', async () => {
    const root = scratch();
    const reviewDir = path.join(root, '.rasterwright', 'review');
    // `before` is a file, so `mkdir` cannot create the directory under it.
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'before'), 'in the way');

    const bytes = Buffer.from('bytes');
    await expect(retainOriginal(reviewDir, 'a.png', bytes, sha256(bytes), 'png')).rejects.toThrow(
      /--no-review/,
    );
  });
});

describe('the manifest', () => {
  it('reports no manifest as undefined rather than as an error', () => {
    expect(readManifest(path.join(scratch(), 'review'))).toBeUndefined();
  });

  it('round-trips', async () => {
    const reviewDir = path.join(scratch(), 'review');
    const manifest: ReviewManifest = { version: 1, retain: 3, runs: [fakeRun('a'), fakeRun('b')] };

    await writeManifest(reviewDir, manifest);

    expect(readManifest(reviewDir)).toEqual(manifest);
  });

  it('replaces atomically, leaving no temp file behind', async () => {
    const reviewDir = path.join(scratch(), 'review');
    await writeManifest(reviewDir, emptyManifest());
    await writeManifest(reviewDir, { version: 1, retain: 1, runs: [fakeRun('a')] });

    expect(fs.readdirSync(reviewDir)).toEqual(['manifest.json']);
    expect(readManifest(reviewDir)?.runs).toHaveLength(1);
  });

  it('refuses a manifest it cannot parse rather than silently replacing it', async () => {
    const reviewDir = path.join(scratch(), 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manifest.json'), '{ not json');

    expect(() => readManifest(reviewDir)).toThrow(/not valid JSON/);
    // Still there: refusing means refusing, not deleting.
    expect(fs.readFileSync(path.join(reviewDir, 'manifest.json'), 'utf8')).toBe('{ not json');
  });

  it('refuses a manifest from a shape it does not understand', () => {
    const reviewDir = path.join(scratch(), 'review');
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'manifest.json'), JSON.stringify({ version: 2, runs: [] }));

    expect(() => readManifest(reviewDir)).toThrow(/not a Rasterwright review manifest/);
  });

  it('normalizes a nonsense retain value to one run', () => {
    expect(normalizeRetain(undefined)).toBe(1);
    expect(normalizeRetain(0)).toBe(1);
    expect(normalizeRetain(-4)).toBe(1);
    expect(normalizeRetain(2.5)).toBe(1);
    expect(normalizeRetain(7)).toBe(7);
  });
});

describe('pruneRuns', () => {
  it('keeps the newest runs and reports the rest', () => {
    const manifest: ReviewManifest = {
      version: 1,
      retain: 2,
      runs: [fakeRun('c'), fakeRun('b'), fakeRun('a')],
    };

    const dropped = pruneRuns(manifest);

    expect(manifest.runs.map((run) => run.runId)).toEqual(['c', 'b']);
    expect(dropped.map((run) => run.runId)).toEqual(['a']);
  });

  it('is a no-op when there are fewer runs than the retention', () => {
    const manifest: ReviewManifest = { version: 1, retain: 5, runs: [fakeRun('a')] };
    expect(pruneRuns(manifest)).toEqual([]);
    expect(manifest.runs).toHaveLength(1);
  });
});

describe('collectGarbage', () => {
  const hashOf = (label: string): string => createHash('sha256').update(label).digest('hex');

  async function store(): Promise<{ reviewDir: string; before: string }> {
    const reviewDir = path.join(scratch(), 'review');
    const before = path.join(reviewDir, 'before');
    fs.mkdirSync(before, { recursive: true });
    return { reviewDir, before };
  }

  it('removes only unreferenced hash-named copies', async () => {
    const { reviewDir, before } = await store();
    const kept = `${hashOf('kept')}.jpg`;
    const orphan = `${hashOf('orphan')}.png`;
    fs.writeFileSync(path.join(before, kept), 'kept');
    fs.writeFileSync(path.join(before, orphan), 'orphan');

    const run = fakeRun('a');
    run.entries[0]!.beforeFile = `before/${kept}`;

    const collection = await collectGarbage(reviewDir, { version: 1, retain: 1, runs: [run] });

    expect(collection.removed).toEqual([orphan]);
    expect(fs.existsSync(path.join(before, kept))).toBe(true);
    expect(fs.existsSync(path.join(before, orphan))).toBe(false);
  });

  it('never touches a file a human put there', async () => {
    const { reviewDir, before } = await store();
    fs.writeFileSync(path.join(before, 'notes.txt'), 'do not delete me');
    fs.writeFileSync(path.join(before, 'holiday.jpg'), 'not hash-named');
    fs.mkdirSync(path.join(before, 'archive'));
    fs.writeFileSync(path.join(before, `${hashOf('x').toUpperCase()}.jpg`), 'wrong case');

    const collection = await collectGarbage(reviewDir, emptyManifest());

    expect(collection.removed).toEqual([]);
    expect(fs.readdirSync(before).sort()).toHaveLength(4);
  });

  it('does nothing at all when there is no store', async () => {
    const reviewDir = path.join(scratch(), 'review');
    await expect(collectGarbage(reviewDir, emptyManifest())).resolves.toEqual({
      removed: [],
      diagnostics: [],
    });
  });
});

describe('beforeStoreBytes', () => {
  it('sums the copies, and is zero when there is no store', () => {
    const reviewDir = path.join(scratch(), 'review');
    expect(beforeStoreBytes(reviewDir)).toBe(0);

    fs.mkdirSync(path.join(reviewDir, 'before'), { recursive: true });
    fs.writeFileSync(path.join(reviewDir, 'before', 'a.jpg'), Buffer.alloc(100));
    fs.writeFileSync(path.join(reviewDir, 'before', 'b.jpg'), Buffer.alloc(50));

    expect(beforeStoreBytes(reviewDir)).toBe(150);
  });
});

describe('entriesFrom', () => {
  it('records what was written and the exceptions beside it', () => {
    const entries = entriesFrom(fakeReport());

    expect(entries.map((entry) => entry.path)).toEqual([
      'assets/hero.jpg',
      'assets/icon.png',
      'assets/huge.png',
    ]);

    const [fixed, skipped, failed] = entries;
    expect(fixed?.beforeFile).toMatch(/^before\/[0-9a-f]{64}\.jpg$/);
    expect(fixed?.after?.contentHash).toBeDefined();

    // Nothing was written for these, so the file on disk still is the original
    // and there is no copy worth keeping.
    expect(skipped?.beforeFile).toBeUndefined();
    expect(skipped?.after).toBeUndefined();
    expect(failed?.beforeFile).toBeUndefined();
  });

  it('omits unchanged files, which the fix report already omits', () => {
    const report = fakeReport();
    expect(report.results.some((result) => result.status === 'unchanged')).toBe(false);
    expect(entriesFrom(report)).toHaveLength(report.results.length);
  });
});
