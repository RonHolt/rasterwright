import { spawnSync } from 'node:child_process';
import fg from 'fast-glob';

import { SUPPORTED_EXTENSIONS } from '../config/schema.js';

/**
 * Directories Rasterwright never walks, regardless of configuration.
 *
 * `.git` and `node_modules` are hard-coded per the scope document.
 * `.rasterwright` is Rasterwright's own working directory.
 */
export const ALWAYS_IGNORED = ['**/.git/**', '**/node_modules/**', '**/.rasterwright/**'];

export interface DiscoveryResult {
  /** Repo-relative POSIX paths, sorted, of every candidate image file. */
  files: string[];
  /** True when `.gitignore` rules were applied. */
  gitignoreApplied: boolean;
  /** Why gitignore filtering was skipped, when it was. */
  gitignoreSkippedReason?: string;
}

export interface DiscoverOptions {
  /** Skip the `.gitignore` filter entirely. */
  noGitignore?: boolean;
}

/**
 * Find every candidate image file under `root`.
 *
 * Hidden files and directories are skipped (`dot: false`), symlinks are not
 * followed, and extension matching is case-insensitive so `HERO.JPG` is found.
 *
 * ## .gitignore support
 *
 * Handled by shelling out to `git check-ignore --stdin`, which gets nested
 * `.gitignore` files, negations, `.git/info/exclude` and the user's global
 * excludes exactly right for free, and avoids either a custom parser or a
 * second glob dependency. `GIT_OPTIONAL_LOCKS=0` is set so git cannot write to
 * the repository while `check` is running.
 *
 * If git is unavailable, or `root` is not inside a git work tree, the filter is
 * skipped and the reason is reported. That is a documented limitation rather
 * than a silent one: outside a repo, git-ignored files are simply checked.
 */
export function discover(root: string, options: DiscoverOptions = {}): DiscoveryResult {
  const pattern = `**/*.{${SUPPORTED_EXTENSIONS.join(',')}}`;

  const found = fg.sync(pattern, {
    cwd: root,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    caseSensitiveMatch: false,
    ignore: [...ALWAYS_IGNORED],
    suppressErrors: true,
  });

  found.sort();

  if (options.noGitignore) {
    return { files: found, gitignoreApplied: false, gitignoreSkippedReason: '--no-gitignore was passed' };
  }
  if (found.length === 0) {
    return { files: found, gitignoreApplied: false, gitignoreSkippedReason: 'nothing to filter' };
  }

  const ignored = gitIgnoredPaths(root, found);
  if (ignored === undefined) {
    return {
      files: found,
      gitignoreApplied: false,
      gitignoreSkippedReason: 'not a git work tree, or git is unavailable',
    };
  }

  return { files: found.filter((file) => !ignored.has(file)), gitignoreApplied: true };
}

/**
 * Ask git which of `paths` are ignored.
 *
 * Returns undefined when git could not answer, which callers treat as
 * "no gitignore filtering", never as "nothing is ignored".
 */
function gitIgnoredPaths(root: string, paths: string[]): Set<string> | undefined {
  const result = spawnSync('git', ['-C', root, 'check-ignore', '--stdin', '-z'], {
    // Buffer in, buffer out: paths may contain any byte a filesystem allows.
    input: Buffer.from(paths.join('\0'), 'utf8'),
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    // Read-only by construction, but belt and braces: never let git take a lock
    // or refresh the index while `check` is running.
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

  if (result.error !== undefined) return undefined;
  // 0 = at least one path ignored, 1 = none ignored, anything else = failure.
  if (result.status !== 0 && result.status !== 1) return undefined;

  const stdout = result.stdout?.toString('utf8') ?? '';
  return new Set(stdout.split('\0').filter((line) => line.length > 0));
}
