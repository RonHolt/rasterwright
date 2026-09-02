import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { defaultPathSemantics, type PathSemantics } from './plan-set.js';
import type { FileHandle } from 'node:fs/promises';

/**
 * The filesystem half of `fix`. Every mutation Rasterwright makes goes through
 * here, and nothing here knows what an image is.
 *
 * The contract, from 04 section 8:
 *
 *   1. the whole output exists in memory and has been verified before anything
 *      is opened for writing;
 *   2. it is written to a temp file in the *same directory*, so the rename that
 *      follows stays on one filesystem and is therefore atomic;
 *   3. the temp file is fsynced, so a crash cannot leave a renamed file whose
 *      contents never reached the disk;
 *   4. `rename()` puts it in place, and the parent directory is fsynced after
 *      it, so the directory entry itself survives a power loss. A reader never
 *      observes a half-written image;
 *   5. on a format conversion the new path is created first and the old path
 *      unlinked second, so a crash between the two leaves both files rather
 *      than neither.
 *
 * File mode is preserved. Mtime deliberately is not: a file that changed should
 * look changed to every tool downstream.
 *
 * ## Never clobbering a path this run did not claim
 *
 * Any rename that creates a *new* name lstats the destination immediately
 * beforehand and refuses if anything is there. Batch preflight has already
 * answered the same question over the whole plan set, so this is the last line
 * of defence rather than the first, and it exists because the two answers are
 * separated by however long the run takes.
 *
 * There is a residual TOCTOU window between that lstat and the rename: another
 * process can create the path in between, and `rename(2)` has no portable
 * "fail if the destination exists" mode (`renameat2` with `RENAME_NOREPLACE` is
 * Linux-only and not exposed by Node). The window is microseconds and the
 * alternative is a link-then-unlink dance that is not atomic either. Documented
 * rather than pretended away.
 *
 * ## Two kinds of interim file, and only one of them is disposable
 *
 * A `.rasterwright-tmp-*` file holds bytes that also exist in memory and, for a
 * rewrite, on disk under the real name. Losing one loses nothing, so the SIGINT
 * handler and the stale sweep both delete them freely.
 *
 * A `*.rasterwright-moving-*` file is the opposite: during a case-only rename it
 * is the *only* copy of the user's image. Nothing ever unlinks one. It is not
 * registered with `TempRegistry`, the sweep skips it, and
 * `recoverInterruptedMoves()` puts it back under its intended name.
 */

/**
 * Prefix for scratch files holding bytes that exist elsewhere too.
 *
 * Leading dot so discovery never sees one (`dot: false`), and distinctive
 * enough that the stale sweep can only ever remove Rasterwright's own residue.
 */
export const TEMP_PREFIX = '.rasterwright-tmp-';

/**
 * Infix for the interim name a case-only rename passes through.
 *
 * Deliberately *not* the temp prefix, and deliberately not a dotfile: this file
 * is the user's image and it must be visible, obviously named after where it
 * was going, and impossible to confuse with disposable residue.
 */
export const MOVING_INFIX = '.rasterwright-moving-';

/** `<target basename>.rasterwright-moving-<pid>-<rand>`, matched to recover it. */
const MOVING_PATTERN = /^(.+)\.rasterwright-moving-\d+-[0-9a-f]+$/;

/** `.rasterwright-tmp-<pid>-<rand><ext>`, matched to read the pid back out. */
const TEMP_PID_PATTERN = /^\.rasterwright-tmp-(\d+)-/;

/**
 * A temp name beside `absTarget`, keeping its extension.
 *
 * Same directory, because a cross-device rename is a copy and a copy is not
 * atomic. The extension is kept so anything that stumbles across the file
 * mid-run (an editor, a watcher) reads it as the kind of file it is.
 */
export function tempNameFor(absTarget: string): string {
  const extension = path.extname(absTarget);
  const name = `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}${extension}`;
  return path.join(path.dirname(absTarget), name);
}

/** The interim name a case-only rename to `absTarget` passes through. */
export function movingNameFor(absTarget: string): string {
  const name = `${path.basename(absTarget)}${MOVING_INFIX}${process.pid}-${randomBytes(6).toString('hex')}`;
  return path.join(path.dirname(absTarget), name);
}

/**
 * Temp paths this process has created and not yet renamed away.
 *
 * The SIGINT handler walks this and unlinks everything in it, which is the
 * whole reason it exists: an interrupted run must leave no residue, and the
 * only files it could leave are the ones in flight at that moment.
 *
 * Only `.rasterwright-tmp-*` paths belong here. A file that is the sole copy of
 * an image must never be registered, because registration means "safe to
 * delete".
 */
export class TempRegistry {
  readonly #paths = new Set<string>();

  add(absolute: string): void {
    if (!path.basename(absolute).startsWith(TEMP_PREFIX)) {
      throw new Error(`refusing to register ${absolute}: only ${TEMP_PREFIX}* files are disposable`);
    }
    this.#paths.add(absolute);
  }

  remove(absolute: string): void {
    this.#paths.delete(absolute);
  }

  /** Temp paths still outstanding, for tests and diagnostics. */
  paths(): string[] {
    return [...this.#paths];
  }

  /**
   * Unlink every outstanding temp file. Never throws: this runs from a signal
   * handler, where the only worse outcome than a leftover file is a crash that
   * leaves all of them.
   *
   * A path that could not be removed stays registered, so `paths()` afterwards
   * is exactly the list of temp files this process created and left behind. The
   * caller reports those; silently forgetting them would leave residue with
   * nothing to point at it.
   */
  cleanup(): string[] {
    const removed: string[] = [];
    for (const absolute of [...this.#paths]) {
      try {
        fs.unlinkSync(absolute);
      } catch (error) {
        // Already gone counts as removed. Anything else stays on the list.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      removed.push(absolute);
      this.#paths.delete(absolute);
    }
    return removed;
  }
}

export interface WriteOptions {
  /** Mode to give the output, normally the source file's. */
  mode: number;
  /** Registry to track the temp file in, so an interrupt can clean it up. */
  registry?: TempRegistry;
  /**
   * Refuse if anything already exists at the target. Set for a rename that
   * creates a new name; left off for an in-place rewrite, where replacing the
   * existing file is the entire point.
   */
  requireAbsent?: boolean;
}

/**
 * Write `buffer` over `absTarget` atomically.
 *
 * The target is replaced by a rename, so a reader either sees the whole old
 * file or the whole new one. `mode` is applied explicitly rather than left to
 * the process umask, because the point is to preserve what the source had.
 */
export async function writeCandidate(
  absTarget: string,
  buffer: Buffer,
  options: WriteOptions,
): Promise<void> {
  if (options.requireAbsent === true) await refuseIfPresent(absTarget);

  const temp = await writeTemp(absTarget, buffer, options);
  try {
    await fsp.rename(temp, absTarget);
  } catch (error) {
    const leftover = await discard(temp, options.registry);
    throw new Error(
      `could not put the new bytes in place at ${absTarget}: ${messageOf(error)}${leftover}`,
    );
  }
  options.registry?.remove(temp);
  trace('rename', `${temp} -> ${absTarget}`);
  await syncDirectory(path.dirname(absTarget));
}

/**
 * Write `buffer` to `absTarget` and then remove `absSource`, in that order.
 *
 * This is a format conversion: the bytes are moving to a new name. Creating the
 * new path first means a crash between the two steps leaves both files, which
 * is recoverable by hand. Unlinking first would make the same crash lose the
 * image entirely.
 *
 * If the new file is written but the old one cannot be removed, this throws
 * saying so. The output is real and in place; the caller has to report that the
 * source is still there rather than treat the file as untouched.
 */
export async function convertAndReplace(
  absSource: string,
  absTarget: string,
  buffer: Buffer,
  mode: number,
  registry?: TempRegistry,
): Promise<void> {
  if (path.resolve(absSource) === path.resolve(absTarget)) {
    throw new Error(`convertAndReplace called with one path: ${absTarget}`);
  }

  await writeCandidate(absTarget, buffer, { mode, registry, requireAbsent: true });

  try {
    await fsp.unlink(absSource);
  } catch (error) {
    throw new Error(
      `wrote ${absTarget} but could not remove ${absSource} (${messageOf(error)}); ` +
        `both ${absSource} and ${absTarget} are now on disk`,
    );
  }
  trace('unlink', absSource);
  await syncDirectory(path.dirname(absSource));
}

/**
 * Whether renaming `absFrom` to `absTo` needs an intermediate step.
 *
 * True only where the filesystem folds case *and* the two names differ only in
 * case: there they are one file, so a direct rename is a no-op and the
 * extension is never corrected. Everywhere else a plain rename is correct, and
 * taking the two-step route anyway would put the user's only copy under an
 * interim name for no reason at all.
 */
export function needsTwoStepRename(
  absFrom: string,
  absTo: string,
  semantics: PathSemantics = defaultPathSemantics(),
): boolean {
  if (semantics !== 'case-insensitive') return false;
  return absFrom !== absTo && absFrom.toLowerCase() === absTo.toLowerCase();
}

export interface RenameOptions {
  /** How the target filesystem compares two paths. Defaults to the platform's. */
  semantics?: PathSemantics;
}

/**
 * Rename a file without touching its pixels.
 *
 * Returns the intermediate path when a two-step rename was needed, and
 * `undefined` otherwise, so a caller (and a test) can tell which route was
 * taken. The intermediate is *not* registered for cleanup and is not swept: for
 * the moment it exists it is the only copy of the image, and the recovery path
 * for it is `recoverInterruptedMoves()`, never deletion.
 */
export async function commitRename(
  absFrom: string,
  absTo: string,
  options: RenameOptions = {},
): Promise<string | undefined> {
  if (!needsTwoStepRename(absFrom, absTo, options.semantics)) {
    if (path.resolve(absFrom) !== path.resolve(absTo)) await refuseIfPresent(absTo);
    await fsp.rename(absFrom, absTo);
    trace('rename', `${absFrom} -> ${absTo}`);
    await syncDirectory(path.dirname(absTo));
    return undefined;
  }

  // A case-only self-rename: the destination *is* the source under another
  // spelling, so there is nothing to refuse and nothing to check for.
  const intermediate = movingNameFor(absTo);
  await fsp.rename(absFrom, intermediate);
  trace('rename', `${absFrom} -> ${intermediate}`);
  await syncDirectory(path.dirname(intermediate));
  abortIf('first-rename');

  try {
    await fsp.rename(intermediate, absTo);
  } catch (error) {
    // The image exists only under the interim name right now, so put it back
    // where it came from before reporting. If even that fails, say exactly
    // where the file is, because it is the user's only copy.
    let restored = false;
    try {
      await fsp.rename(intermediate, absFrom);
      restored = true;
    } catch {
      restored = false;
    }
    throw new Error(
      `could not rename ${absFrom} to ${absTo} (${messageOf(error)}); ` +
        (restored
          ? 'the file was put back under its original name'
          : `the file is currently at ${intermediate} and must be renamed by hand`),
    );
  }

  trace('rename', `${intermediate} -> ${absTo}`);
  await syncDirectory(path.dirname(absTo));
  return intermediate;
}

export interface MoveRecovery {
  /** Interim files put back under their intended name, as that name. */
  recovered: string[];
  /** Interim files left alone because their intended name is occupied. */
  needsAttention: string[];
}

/**
 * Put back any image left under an interim name by an interrupted rename.
 *
 * A `*.rasterwright-moving-*` file is a real image that a hard kill caught
 * between the two halves of a case-only rename. Its intended name is encoded in
 * its own name, so recovery is deterministic and needs no journal.
 *
 * Nothing here ever unlinks. Where the intended name is already occupied the
 * file is left exactly as it is and reported, because the one thing worse than
 * an oddly named image is a deleted one.
 */
export async function recoverInterruptedMoves(
  directories: Iterable<string>,
  semantics: PathSemantics = defaultPathSemantics(),
): Promise<MoveRecovery> {
  const fold = (value: string): string =>
    semantics === 'case-insensitive' ? value.toLowerCase() : value;

  const recovery: MoveRecovery = { recovered: [], needsAttention: [] };
  const seen = new Set<string>();

  for (const directory of directories) {
    const absolute = path.resolve(directory);
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    let entries: string[];
    try {
      entries = (await fsp.readdir(absolute)).sort();
    } catch {
      continue;
    }

    // The listing is the source of truth for what is occupied, and it changes
    // as files are put back, so it is tracked rather than re-read.
    const present = new Set(entries.map(fold));

    for (const entry of entries) {
      const match = MOVING_PATTERN.exec(entry);
      if (match === null) continue;
      const intended = match[1] as string;

      if (present.has(fold(intended))) {
        recovery.needsAttention.push(path.join(absolute, entry));
        continue;
      }

      try {
        await fsp.rename(path.join(absolute, entry), path.join(absolute, intended));
      } catch {
        recovery.needsAttention.push(path.join(absolute, entry));
        continue;
      }
      present.delete(fold(entry));
      present.add(fold(intended));
      recovery.recovered.push(path.join(absolute, intended));
    }

    if (recovery.recovered.length > 0) await syncDirectory(absolute);
  }

  recovery.recovered.sort();
  recovery.needsAttention.sort();
  return recovery;
}

/**
 * Remove Rasterwright's leftover temp files from `directories`.
 *
 * Only `.rasterwright-tmp-*` files are touched, only in the directories the run
 * is about to write to, and only where the process that created them is gone.
 * A live pid means another Rasterwright run is using that file right now, and
 * deleting it out from under a concurrent run would turn a safe write into a
 * failed one.
 *
 * `*.rasterwright-moving-*` files are never swept. They are images, not
 * residue; see `recoverInterruptedMoves()`.
 *
 * Returns the absolute paths removed.
 */
export async function sweepStaleTemps(directories: Iterable<string>): Promise<string[]> {
  const removed: string[] = [];
  const seen = new Set<string>();

  for (const directory of directories) {
    const absolute = path.resolve(directory);
    if (seen.has(absolute)) continue;
    seen.add(absolute);

    let entries: string[];
    try {
      entries = await fsp.readdir(absolute);
    } catch {
      // An unreadable directory is not this function's problem to report. The
      // run is about to fail on it for a better reason.
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith(TEMP_PREFIX)) continue;
      if (entry.includes(MOVING_INFIX)) continue;

      const pid = TEMP_PID_PATTERN.exec(entry)?.[1];
      if (pid !== undefined && isProcessAlive(Number(pid))) continue;

      const target = path.join(absolute, entry);
      try {
        await fsp.unlink(target);
        removed.push(target);
      } catch {
        // A directory that happens to be named like a temp file, or a race with
        // another Rasterwright process. Leave it; it harms nothing.
      }
    }
  }

  return removed.sort();
}

/**
 * Whether a process is still running.
 *
 * `EPERM` means it exists and belongs to somebody else, which counts as alive:
 * the question is whether its temp file is still in use, not who owns it.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Refuse to rename onto a path that already holds something. */
async function refuseIfPresent(absTarget: string): Promise<void> {
  let stats: fs.Stats | undefined;
  try {
    stats = fs.lstatSync(absTarget, { throwIfNoEntry: false });
  } catch (error) {
    throw new Error(`could not check whether ${absTarget} exists: ${messageOf(error)}`);
  }
  if (stats !== undefined) {
    throw new Error(`refusing to write ${absTarget}: something already exists there`);
  }
}

/**
 * Write the bytes to a temp file beside the target and get them onto the disk.
 *
 * The fsync is what makes the following rename meaningful: without it a crash
 * can leave the directory entry pointing at a file whose contents were still in
 * the page cache.
 */
async function writeTemp(absTarget: string, buffer: Buffer, options: WriteOptions): Promise<string> {
  const temp = tempNameFor(absTarget);
  options.registry?.add(temp);

  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(temp, 'wx', options.mode);
    await handle.writeFile(buffer);
    // `open` applies the process umask to `mode`, so set it again explicitly:
    // preserving the source's permissions is the point, not approximating them.
    await handle.chmod(options.mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    const leftover = await discard(temp, options.registry);
    throw new Error(`could not stage the new bytes for ${absTarget}: ${messageOf(error)}${leftover}`);
  }

  trace('temp-write', temp);
  abortIf('temp-write');
  await stall();
  return temp;
}

/**
 * Flush the directory entry itself.
 *
 * A rename is atomic with respect to readers, but the directory entry can still
 * be sitting in the page cache when the power goes out. Failures are tolerated:
 * some filesystems and platforms do not allow opening a directory for reading,
 * and refusing a rename that already succeeded would be worse than the risk.
 */
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

/**
 * Remove a temp file that is not going to be used, without masking the real
 * error. Returns a phrase naming the leftover when it could not be removed.
 *
 * A discard that itself fails is rare and worth saying out loud: the file is
 * disposable, but only somebody looking at the tree can delete it now. It stays
 * registered so the end-of-run cleanup retries it, and so it is still listed if
 * that retry fails too.
 */
async function discard(temp: string, registry?: TempRegistry): Promise<string> {
  try {
    await fsp.unlink(temp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `; ${temp} was left behind and could not be removed either (${messageOf(error)})`;
    }
  }
  registry?.remove(temp);
  return '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/*
 * ---------------------------------------------------------------------------
 * Test-only hooks
 *
 * Both are read from the environment on every call and do nothing unless set,
 * so a normal run pays one `process.env` lookup per step and behaves exactly as
 * if they did not exist. They are here because the properties worth proving -
 * "a second run writes zero bytes", "a crash between fsync and rename leaves the
 * original intact" - are only observable from outside a spawned CLI process,
 * where a stub cannot be injected.
 *
 *   RASTERWRIGHT_TRACE_WRITES=<path>
 *     Appends one line per mutating filesystem step: `temp-write <path>`,
 *     `rename <from> -> <to>`, `unlink <path>`. An idempotent run appends
 *     nothing, so an empty trace file is the assertion.
 *
 *   RASTERWRIGHT_ABORT_AFTER=<step>
 *     Calls `process.abort()` immediately after the named step. `temp-write`
 *     aborts between the fsync and the rename, the one moment temp residue is
 *     possible. `first-rename` aborts between the two halves of a case-only
 *     rename, the one moment an image exists only under its interim name.
 *
 *   RASTERWRIGHT_STALL_MS=<n>
 *     Waits `n` milliseconds at that same moment, so a test can deliver SIGINT
 *     while a write is genuinely in flight rather than guessing at the timing.
 *     Sitting beside `abortIf` is the point: both hooks mark the one instant
 *     where a temp file exists and the rename has not happened.
 * ---------------------------------------------------------------------------
 */

function trace(step: string, detail: string): void {
  const target = process.env.RASTERWRIGHT_TRACE_WRITES;
  if (target === undefined || target === '') return;
  try {
    fs.appendFileSync(target, `${step} ${detail}\n`);
  } catch {
    // A broken trace path must never change what the run does.
  }
}

function abortIf(step: string): void {
  if (process.env.RASTERWRIGHT_ABORT_AFTER === step) process.abort();
}

async function stall(): Promise<void> {
  const milliseconds = Number(process.env.RASTERWRIGHT_STALL_MS ?? '');
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
