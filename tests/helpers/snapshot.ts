import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FileState {
  path: string;
  size: number;
  mode: number;
  mtimeMs: number;
  hash: string;
}

/**
 * Record every file under `root`: path, size, mode, mtime and content hash.
 *
 * Deliberately does not record access time - reading a file legitimately
 * updates atime on many filesystems, and `check` is allowed to read.
 */
export function snapshotTree(root: string): FileState[] {
  const states: FileState[] = [];

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(absolute);
      states.push({
        path: path.relative(root, absolute).split(path.sep).join('/'),
        size: stat.size,
        mode: stat.mode,
        mtimeMs: stat.mtimeMs,
        hash: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
      });
    }
  };

  walk(root);
  return states;
}

/** Directory paths under `root`, so a new empty directory is caught too. */
export function snapshotDirs(root: string): string[] {
  const dirs: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = path.join(dir, entry.name);
      dirs.push(path.relative(root, absolute).split(path.sep).join('/'));
      walk(absolute);
    }
  };
  walk(root);
  return dirs.sort();
}
