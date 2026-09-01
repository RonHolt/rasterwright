import path from 'node:path';

/** Convert an absolute path to a repo-relative POSIX path. */
export function toRelativePosix(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

/** Resolve a repo-relative POSIX path back to an absolute platform path. */
export function toAbsolute(root: string, relativePosix: string): string {
  return path.resolve(root, relativePosix.split('/').join(path.sep));
}
