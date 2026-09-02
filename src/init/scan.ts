import { discover } from '../scanner/discover.js';
import { inspect } from '../scanner/inspect.js';
import { defaultConcurrency, mapWithConcurrency } from '../utils/concurrency.js';
import type { ImageInfo } from '../types.js';

/**
 * The read-only half of `init`.
 *
 * Exactly the discovery and inspection `check` performs, minus the policy: at
 * this point there is no config to resolve against, which is the whole reason
 * the command exists. Every image found is inspected, because the heuristic
 * cannot know which ones will end up governed until after it has seen them all.
 *
 * Nothing here writes. An image that will not decode is counted and set aside
 * rather than failing the run: a corrupt file is a fact about the repository,
 * and refusing to generate a config because of one would be unhelpful in
 * exactly the repository that most needs a config.
 */

export interface ScanOptions {
  /** Include git-ignored files in the scan. */
  noGitignore?: boolean;
  concurrency?: number;
}

export interface ScanResult {
  /** Every candidate image, repo-relative POSIX, sorted. */
  discovered: string[];
  /** What could be measured, in discovery order. */
  infos: ImageInfo[];
  /** Paths that would not decode, with the reason, sorted by path. */
  unreadable: Array<{ path: string; error: string }>;
  /** How many images the `.gitignore` filter removed before inspection. */
  gitIgnored: number;
  gitignoreApplied: boolean;
  gitignoreSkippedReason: string | undefined;
}

export async function scanForInit(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const discovery = discover(root, { noGitignore: options.noGitignore ?? false });

  const results = await mapWithConcurrency(
    discovery.files,
    options.concurrency ?? defaultConcurrency(),
    async (relativePath) => inspect(root, relativePath),
  );

  const infos: ImageInfo[] = [];
  const unreadable: Array<{ path: string; error: string }> = [];
  for (const result of results) {
    if (result.ok) infos.push(result.info);
    else unreadable.push({ path: result.path, error: result.error });
  }

  return {
    discovered: discovery.files,
    infos,
    unreadable,
    gitIgnored: discovery.ignoredCount,
    gitignoreApplied: discovery.gitignoreApplied,
    gitignoreSkippedReason: discovery.gitignoreSkippedReason,
  };
}
