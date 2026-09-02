import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { RasterwrightError } from '../utils/errors.js';
import { sha256 } from '../utils/hash.js';
import { toAbsolute } from '../utils/paths.js';

/**
 * `--backup-dir`: a copy of every original, taken immediately before it is
 * overwritten.
 *
 * 04 section 8 makes git the undo mechanism and deliberately does not keep
 * backups, because a parallel set of copies is a second, worse version control
 * system. This is the escape hatch for the case git cannot cover: a project
 * that is not in a repository at all, where an overwrite is otherwise
 * unrecoverable. It is opt-in, it is never written to by default, and nothing
 * reads it back - restoring is a `cp`, which is the point.
 *
 * ## Why the directory may not live inside the project
 *
 * A backup directory under the project root would be walked by the next
 * `discover()`, its copies governed by the project's own globs, and its
 * directories swept for stale temp files. Rasterwright would end up checking,
 * planning and fixing its own backups. The reverse nesting is refused for the
 * same reason in the other direction: a backup directory that contains the
 * project makes "which of these is the real tree" a question, and it is not one
 * worth having.
 *
 * ## Mirrored, not flattened
 *
 * A copy lands at `<backupDir>/<repo-relative path>`. Flattening would put two
 * different `logo.png` files at one path and let the second silently win, which
 * is precisely the failure the directory exists to prevent.
 */

/**
 * Validate `raw` and return it as an absolute path. Creates nothing.
 *
 * Resolved against the process working directory rather than the project root,
 * because a relative `--backup-dir backups` should mean what it means in the
 * shell the user typed it into.
 *
 * The directory is created lazily, by the first copy that needs it. Creating it
 * here would mean a run refused for some later reason - or one that turned out
 * to have nothing to write at all - still leaving an empty directory behind,
 * and "Rasterwright refused and changed nothing" has to be true everywhere it
 * is claimed.
 */
export function resolveBackupDir(root: string, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new RasterwrightError('--backup-dir: expected a directory path, got an empty string');
  }

  const absolute = path.resolve(process.cwd(), trimmed);
  const projectRoot = path.resolve(root);

  if (absolute === projectRoot || contains(projectRoot, absolute) || contains(absolute, projectRoot)) {
    throw new RasterwrightError(
      `--backup-dir ${absolute} overlaps the project at ${projectRoot}`,
      'Choose a directory outside the project, so Rasterwright never checks or fixes its own backups.',
    );
  }

  // Reading is allowed here; creating is not. A path that already exists and is
  // not a directory can never become one, so that is worth refusing up front
  // rather than as a failure on the first file.
  const existing = fs.statSync(absolute, { throwIfNoEntry: false });
  if (existing !== undefined && !existing.isDirectory()) {
    throw new RasterwrightError(`--backup-dir ${absolute} exists and is not a directory`);
  }

  return absolute;
}

/**
 * Copy one original into the backup directory.
 *
 * Reruns are the normal case - a run that failed halfway is rerun, and the
 * files it already fixed are compliant and produce no plan the second time - so
 * an existing backup is not an error by itself. It is only an error when it
 * holds *different* bytes, because overwriting it would replace the last copy
 * of the true original with a copy of an intermediate state. That refusal fails
 * the one file and leaves it untouched, which is the same shape as every other
 * per-file failure.
 */
export async function backupOriginal(
  backupDir: string,
  relativePath: string,
  bytes: Buffer,
): Promise<string> {
  const target = toAbsolute(backupDir, relativePath);

  let existing: Buffer | undefined;
  try {
    existing = await fsp.readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`could not read the existing backup at ${target}: ${(error as Error).message}`);
    }
  }

  if (existing !== undefined) {
    if (sha256(existing) === sha256(bytes)) return target;
    throw new Error(
      `${target} already holds a different backup of ${relativePath}; ` +
        'refusing to overwrite it, because it may be the only copy of the original',
    );
  }

  await fsp.mkdir(path.dirname(target), { recursive: true });
  // `wx` rather than a plain write: two concurrent workers can never be backing
  // up one path, but a concurrent *run* can, and losing that race silently
  // would be the one outcome this function exists to prevent.
  const handle = await fsp.open(target, 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  return target;
}

/** Whether `child` sits inside `parent`. */
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
