import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { RasterwrightError } from '../utils/errors.js';
import type { FileHandle } from 'node:fs/promises';
import type { FixReport, ImageFormat, ReviewEntry, ReviewManifest, ReviewRun } from '../types.js';

/**
 * The on-disk half of `review`: where the data lives, and how it is written.
 *
 * ```
 * .rasterwright/
 *   review/
 *     index.html          rendered by `review`, safe to delete
 *     manifest.json       one entry per run, newest first
 *     before/<sha256>.<ext>
 * ```
 *
 * Two properties shape everything here.
 *
 * **Content-hash naming.** A before-copy is named for the sha256 of the bytes it
 * holds, so a file copied twice lands at one name holding identical bytes, and
 * an `EEXIST` is success rather than a conflict. Two runs over one project
 * cannot fight over a name, and an unchanged file is never copied twice.
 *
 * **Created lazily, never speculatively.** `resolveReviewDir` validates and
 * returns a path; the first copy that needs the directory creates it. A run that
 * refuses, or that turns out to have nothing to write, leaves nothing behind -
 * the same discipline `--backup-dir` follows, and the reason `check` and
 * `fix --dry-run` can still promise they create no `.rasterwright/`.
 */

/** The directory `fix` writes review data into, and `review` reads it from. */
export function reviewDirFor(root: string): string {
  return path.join(root, '.rasterwright', 'review');
}

export function manifestPathFor(reviewDir: string): string {
  return path.join(reviewDir, 'manifest.json');
}

export function beforeDirFor(reviewDir: string): string {
  return path.join(reviewDir, 'before');
}

export function indexPathFor(reviewDir: string): string {
  return path.join(reviewDir, 'index.html');
}

/**
 * Validate the whole review path and return the review directory. Creates nothing.
 *
 * All three levels are checked - `.rasterwright`, `.rasterwright/review` and
 * `before/` - because a run refusing once, up front, is strictly better than the
 * same obstruction failing every file in turn. No amount of trying will turn a
 * regular file into a directory, so there is nothing to be gained by finding out
 * per image. Everything else - an unwritable parent, a full disk - is left to
 * surface as a per-file failure on the first copy, where it belongs.
 *
 * ## `lstat`, not `stat`
 *
 * A symlink is refused even when it points at a real directory. Rasterwright
 * writes copies of the user's images here and later deletes unreferenced ones,
 * and a link makes both of those happen somewhere the path does not name. A
 * dangling symlink matters twice over: `stat` reports it as absent, `mkdir` then
 * fails `EEXIST`, and the run would fail every file with an errno instead of one
 * sentence naming the link.
 */
export function resolveReviewDir(root: string, hint: string = FIX_HINT): string {
  const base = path.join(root, '.rasterwright');
  const review = reviewDirFor(root);
  for (const candidate of [base, review, beforeDirFor(review)]) {
    requireDirectoryOrAbsent(candidate, hint);
  }
  return review;
}

/** What to suggest when the path is obstructed. `review` passes its own; `fix` takes this one. */
const FIX_HINT = 'Move it out of the way, or rerun with --no-review to fix the images without keeping copies.';

/** Refuse anything at `target` that is not a real directory. Absent is fine. */
function requireDirectoryOrAbsent(target: string, hint: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(target);
  } catch (error) {
    // Absent is the ordinary case: nothing has been created yet.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new RasterwrightError(
      `could not check ${target}, where review data is kept: ${messageOf(error)}`,
      hint,
    );
  }

  if (stats.isDirectory()) return;

  const what = stats.isSymbolicLink() ? 'is a symlink' : 'exists and is not a directory';
  throw new RasterwrightError(`${target} ${what}, so review data cannot be kept there`, hint);
}

/** Extensions a before-copy may carry, which is also what garbage collection recognises. */
const BEFORE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/** `<64 hex>.<ext>`, and nothing else, is Rasterwright's to delete. */
export const BEFORE_NAME_PATTERN = /^[0-9a-f]{64}\.(jpe?g|png|webp)$/;

/** The canonical extension for a format, when a path cannot supply one. */
const FORMAT_EXTENSIONS: Record<ImageFormat, string> = { jpeg: '.jpg', png: '.png', webp: '.webp' };

/**
 * The extension a before-copy is stored under.
 *
 * The detected format decides, and the path's own extension is used only when
 * the two agree. Rasterwright exists partly because `logo.png` holding WebP
 * bytes is a real thing that happens, and storing that copy as `.png` would put
 * a file on disk that no viewer opens correctly - a misleading extension being
 * exactly the fault the `extension` check reports.
 *
 * The result is always one of four known extensions, so every stored name stays
 * inside `BEFORE_NAME_PATTERN` and therefore inside what garbage collection will
 * ever remove. A name outside that pattern would be retained forever.
 */
export function beforeExtension(relativePath: string, format: ImageFormat): string {
  const cut = relativePath.lastIndexOf('.');
  const extension = cut === -1 ? '' : relativePath.slice(cut).toLowerCase();
  if (BEFORE_EXTENSIONS.has(extension) && EXTENSION_FORMAT[extension] === format) return extension;
  return FORMAT_EXTENSIONS[format];
}

/** Which format each accepted extension claims, so a disagreement is visible. */
const EXTENSION_FORMAT: Record<string, ImageFormat> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
};

/**
 * Keep a copy of one original, and return its name relative to the review
 * directory.
 *
 * `hash` is the sha256 of `bytes`, which the executor has already computed for
 * its plan-drift check, so this costs one write and no hashing.
 *
 * `wx` and an fsync, exactly as `backupOriginal` does. `EEXIST` means a copy of
 * these bytes is already stored - by an earlier run, or by another file with
 * identical contents - and that is a success: content-hash naming makes the two
 * copies the same file by construction.
 */
export async function retainOriginal(
  reviewDir: string,
  relativePath: string,
  bytes: Buffer,
  hash: string,
  format: ImageFormat,
): Promise<string> {
  const name = `${hash}${beforeExtension(relativePath, format)}`;
  const directory = beforeDirFor(reviewDir);
  const target = path.join(directory, name);

  // The `mkdir` is deliberately outside the block below. `mkdir` on a path that
  // is already a *file* also raises EEXIST, and treating that as "the copy is
  // already stored" would report a copy that does not exist and let the write
  // proceed over an original nothing had kept.
  try {
    await fsp.mkdir(directory, { recursive: true });
  } catch (error) {
    throw copyFailure(target, error);
  }

  try {
    const handle = await fsp.open(target, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Content-hash naming makes an existing file at this name the same bytes by
    // construction, so this is an unchanged file that was already copied, or a
    // concurrent run that got there first. Both are successes.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw copyFailure(target, error);
  }

  return `before/${name}`;
}

/** What a failed copy says, including the way to run without keeping one. */
function copyFailure(target: string, error: unknown): Error {
  return new Error(
    `could not keep a copy of the original at ${target} (${messageOf(error)}); ` +
      'the file was left exactly as it was. Rerun with --no-review to fix it without keeping copies',
  );
}

/** An empty manifest, which is what a project with no recorded run has. */
export function emptyManifest(): ReviewManifest {
  return { version: 1, retain: 1, runs: [] };
}

/**
 * Read the manifest, or `undefined` when no run has been recorded.
 *
 * A manifest that exists and cannot be understood throws. Silently replacing it
 * would delete the only record of what earlier runs did to the user's images,
 * and silently ignoring it would make `review` render an empty page while the
 * data sat right there. `review --clean` is the way out and the message says so.
 */
export function readManifest(reviewDir: string): ReviewManifest | undefined {
  const file = manifestPathFor(reviewDir);

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new RasterwrightError(`could not read ${file}: ${messageOf(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RasterwrightError(
      `${file} is not valid JSON (${messageOf(error)})`,
      'Run `rasterwright review --clean` to discard the review data and start again.',
    );
  }

  const manifest = parsed as Partial<ReviewManifest> | null;
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.runs)
  ) {
    throw new RasterwrightError(
      `${file} is not a Rasterwright review manifest this version understands`,
      'Run `rasterwright review --clean` to discard the review data and start again.',
    );
  }

  return {
    version: 1,
    retain: normalizeRetain(manifest.retain),
    runs: manifest.runs as ReviewRun[],
  };
}

/** `retain` is at least one run: keeping none would make the whole store pointless. */
export function normalizeRetain(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return 1;
  return value;
}

/** Keep the newest `manifest.retain` runs. Returns the runs that were dropped. */
export function pruneRuns(manifest: ReviewManifest): ReviewRun[] {
  const keep = normalizeRetain(manifest.retain);
  if (manifest.runs.length <= keep) return [];
  const dropped = manifest.runs.slice(keep);
  manifest.runs = manifest.runs.slice(0, keep);
  return dropped;
}

/**
 * Write the manifest atomically: temp file, fsync, rename, fsync the directory.
 *
 * The same discipline `operations/atomic.ts` applies to images, for the same
 * reason: a half-written manifest is worse than no manifest, because it reads as
 * corrupt on the next run and takes the record of every retained run with it.
 */
export async function writeManifest(reviewDir: string, manifest: ReviewManifest): Promise<void> {
  await writeAtomically(reviewDir, manifestPathFor(reviewDir), '.manifest', `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Write the rendered page the same way, for a second reason as well.
 *
 * `index.html` is a path a user can replace with anything, including a symlink
 * pointing outside the project. Writing through an opened target would follow
 * that link and put Rasterwright's output somewhere the path does not name;
 * renaming onto it replaces the link itself and writes nothing through it. Same
 * rule the review directory follows, one level down.
 */
export async function writePage(reviewDir: string, html: string): Promise<void> {
  await writeAtomically(reviewDir, indexPathFor(reviewDir), '.index', html);
}

/** Temp file, fsync, rename, fsync the directory. Never writes through `target`. */
async function writeAtomically(
  reviewDir: string,
  target: string,
  tempPrefix: string,
  contents: string,
): Promise<void> {
  await fsp.mkdir(reviewDir, { recursive: true });
  const temp = path.join(reviewDir, `${tempPrefix}-${process.pid}-${randomBytes(6).toString('hex')}.tmp`);

  try {
    const handle = await fsp.open(temp, 'wx');
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temp, target);
  } catch (error) {
    await fsp.unlink(temp).catch(() => undefined);
    throw new Error(`could not write ${target}: ${messageOf(error)}`);
  }

  await syncDirectory(reviewDir);
}

export interface GarbageCollection {
  /** Before-copies removed, as bare names. */
  removed: string[];
  /** Copies that could not be removed, as ready-made sentences. */
  diagnostics: string[];
}

/**
 * Remove before-copies no retained run refers to.
 *
 * Two rules keep this from ever eating something it should not:
 *
 *   1. only names matching `BEFORE_NAME_PATTERN` are candidates, so a `notes.txt`
 *      or a subdirectory a human put in `before/` is left strictly alone;
 *   2. only names absent from every retained run's entries are removed.
 *
 * An unlink that fails is a diagnostic. The copy is disposable by definition, so
 * failing the command over one would be a refusal with nothing behind it.
 */
export async function collectGarbage(
  reviewDir: string,
  manifest: ReviewManifest,
): Promise<GarbageCollection> {
  const referenced = new Set<string>();
  for (const run of manifest.runs) {
    for (const entry of run.entries) {
      if (entry.beforeFile !== undefined) referenced.add(path.posix.basename(entry.beforeFile));
    }
  }

  const directory = beforeDirFor(reviewDir);
  let entries: string[];
  try {
    entries = await fsp.readdir(directory);
  } catch {
    return { removed: [], diagnostics: [] };
  }

  const collection: GarbageCollection = { removed: [], diagnostics: [] };
  for (const name of entries.sort()) {
    if (!BEFORE_NAME_PATTERN.test(name)) continue;
    if (referenced.has(name)) continue;
    try {
      await fsp.unlink(path.join(directory, name));
      collection.removed.push(name);
    } catch (error) {
      collection.diagnostics.push(
        `could not remove the unreferenced copy at ${path.join(directory, name)}: ${messageOf(error)}`,
      );
    }
  }

  return collection;
}

/** Total bytes held in `before/`, for the page header. Zero when there is no store. */
export function beforeStoreBytes(reviewDir: string): number {
  const directory = beforeDirFor(reviewDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }

  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const stats = fs.statSync(path.join(directory, entry.name), { throwIfNoEntry: false });
    total += stats?.size ?? 0;
  }
  return total;
}

/**
 * Every result this run is worth recording.
 *
 * A `fixed` result is the point: it was written, so there is a before and an
 * after to compare. The exceptions - failed, blocked, skipped - are recorded
 * alongside without a before-copy, because the file on disk still *is* the
 * original and copying it would store the same bytes twice. They are here so
 * the page can list what the run could not do next to what it did, which is the
 * "needs attention first" section's whole content.
 */
export function entriesFrom(report: FixReport): ReviewEntry[] {
  const entries: ReviewEntry[] = [];

  for (const result of report.results) {
    if (result.status === 'unchanged') continue;

    const entry: ReviewEntry = {
      path: result.path,
      outputPath: result.outputPath,
      status: result.status,
      before: result.before,
      applied: result.applied,
      operations: result.plan.operations.length > 0 ? result.plan.operations : result.plan.blockedOperations,
      warnings: result.warnings,
      requiredPermissions: result.plan.requiredPermissions,
    };

    if (result.beforeFile !== undefined) entry.beforeFile = result.beforeFile;
    if (result.after !== undefined) entry.after = result.after;
    if (result.savingsPct !== undefined) entry.savingsPct = result.savingsPct;
    if (result.encode !== undefined) entry.encode = result.encode;
    if (result.reason !== undefined) entry.reason = result.reason;
    entries.push(entry);
  }

  return entries;
}

/** Flush a directory entry. Tolerated failures match `operations/atomic.ts`. */
const DIRECTORY_SYNC_TOLERATED = new Set(['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EACCES', 'ENOENT']);

async function syncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (!DIRECTORY_SYNC_TOLERATED.has(code)) throw error;
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
