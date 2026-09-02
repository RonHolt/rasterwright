import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { afterKey, renderPage, type AfterState } from './review/html.js';
import {
  beforeStoreBytes,
  collectGarbage,
  indexPathFor,
  normalizeRetain,
  pruneRuns,
  readManifest,
  resolveReviewDir,
  reviewDirFor,
  writeManifest,
  writePage,
} from './review/store.js';
import { RasterwrightError } from './utils/errors.js';
import { sha256 } from './utils/hash.js';
import { toAbsolute } from './utils/paths.js';
import type { LoadedConfig } from './config/load.js';
import type { ReviewManifest } from './types.js';

/**
 * `rasterwright review`: turn what `fix` recorded into a page.
 *
 * Read-mostly. It renders `index.html`, and it writes the manifest only when the
 * user changed retention with `--keep`. It never creates `.rasterwright/`: with
 * no manifest there is nothing to render, and creating a directory to hold an
 * empty page would be a write nobody asked for.
 *
 * ## Stale outputs
 *
 * The page can be opened days after the run that produced it, over a working
 * tree that has moved on. Every entry's output is checked against the hash the
 * run recorded, so a card can say "this file has changed since the run" instead
 * of showing a later edit as though Rasterwright had produced it. This is the
 * whole reason `FixResult.after` carries a content hash.
 */

export interface RunReviewOptions {
  /** `--keep <n>`: persist a new retention count, prune to it, and collect garbage. */
  keep?: number;
  /** `--clean`: delete `.rasterwright/review/` and render nothing. */
  clean?: boolean;
}

export interface RunReviewResult {
  /** Absolute path to the review directory, whether or not it exists. */
  reviewDir: string;
  /** Absolute path to the page, when one was written. */
  indexPath?: string;
  /** True when there is no manifest, so there was nothing to render. */
  empty: boolean;
  /** True when `--clean` removed a directory that was there. */
  cleaned: boolean;
  /** The manifest as it now stands. Undefined when there is none. */
  manifest?: ReviewManifest;
  /** Before-copies garbage collection removed. */
  collected: string[];
  diagnostics: string[];
}

export async function runReview(
  config: LoadedConfig,
  options: RunReviewOptions = {},
): Promise<RunReviewResult> {
  const reviewDir = reviewDirFor(config.root);
  const result: RunReviewResult = {
    reviewDir,
    empty: false,
    cleaned: false,
    collected: [],
    diagnostics: [],
  };

  // `--clean` removes `review/` and never `.rasterwright/` itself. The parent is
  // Rasterwright's namespace in the project and later phases may put other
  // things in it; deleting a directory this command does not own would be a
  // surprise, and an empty one costs nothing.
  if (options.clean === true) {
    // Retention describes what to keep from now on, and `--clean` keeps nothing
    // at all. Silently letting one win would make the command's effect depend on
    // an argument order nobody wrote down.
    if (options.keep !== undefined) {
      throw new RasterwrightError(
        '--clean and --keep ask for opposite things: one deletes the review data, the other says how much of it to retain',
        'Run `rasterwright review --clean` on its own, or `--keep <n>` on its own.',
      );
    }
    // `lstat`, not `existsSync`: a dangling symlink is something that was there
    // and is now gone, and saying "nothing to remove" about a link this command
    // just unlinked would be a plain untruth.
    result.cleaned = lstatOf(reviewDir) !== undefined;
    await fsp.rm(reviewDir, { recursive: true, force: true });
    result.empty = true;
    return result;
  }

  // Past `--clean`, every remaining path both reads and writes under
  // `.rasterwright/`, so the same up-front check `fix` makes applies here: a
  // symlink at any level would have this command read a manifest and drop a
  // page somewhere the path does not name. `--clean` is deliberately left
  // outside the check, because unlinking a link is exactly the right answer to
  // finding one.
  resolveReviewDir(config.root, REVIEW_HINT);

  const manifest = readManifest(reviewDir);
  if (manifest === undefined) {
    result.empty = true;
    return result;
  }
  result.manifest = manifest;

  // Retention is persisted rather than applied per invocation. If `--keep` were
  // a flag on this command alone, the next `fix` would prune straight back to
  // one run and `--keep 5` could never actually show five runs.
  if (options.keep !== undefined) {
    manifest.retain = normalizeRetain(options.keep);
    pruneRuns(manifest);
    // Written before anything is collected, for the reason `run-fix.ts` gives:
    // a manifest that survives referring to copies that did not is the one
    // failure worth ordering around.
    await writeManifest(reviewDir, manifest);
    const collection = await collectGarbage(reviewDir, manifest);
    result.collected = collection.removed;
    result.diagnostics.push(...collection.diagnostics);
  }

  const page = renderPage(manifest, {
    after: surveyOutputs(config.root, manifest),
    generatedAt: new Date(),
    storeBytes: beforeStoreBytes(reviewDir),
  });

  // Written the way the manifest is: into a temp file, then renamed over the
  // target. An `index.html` a user has replaced with a symlink is replaced in
  // turn, rather than being written through to wherever it pointed.
  await writePage(reviewDir, page);
  result.indexPath = indexPathFor(reviewDir);
  return result;
}

/** `--no-review` is a `fix` flag, so it is no use to anyone reading this command's error. */
const REVIEW_HINT = 'Move it out of the way, then rerun `rasterwright fix` to record a run there.';

/**
 * What is at each entry's output path right now.
 *
 * A written file is compared by hash, because a file that exists is not
 * necessarily the file the run produced. Anything else is checked only for
 * existence: there is no recorded hash to compare against, and the point of
 * showing it is that the original is still on disk.
 */
function surveyOutputs(root: string, manifest: ReviewManifest): Map<string, AfterState> {
  const states = new Map<string, AfterState>();
  const hashes = new Map<string, string | undefined>();

  for (const run of manifest.runs) {
    for (const entry of run.entries) {
      const key = afterKey(run.runId, entry.outputPath);
      if (states.has(key)) continue;

      const absolute = toAbsolute(root, entry.outputPath);
      if (entry.after === undefined) {
        states.set(key, fs.existsSync(absolute) ? 'present' : 'missing');
        continue;
      }

      // One read per distinct path across every retained run, not per entry:
      // two runs over one project describe the same files.
      if (!hashes.has(absolute)) {
        try {
          hashes.set(absolute, sha256(fs.readFileSync(absolute)));
        } catch {
          hashes.set(absolute, undefined);
        }
      }

      const current = hashes.get(absolute);
      if (current === undefined) states.set(key, 'missing');
      else states.set(key, current === entry.after.contentHash ? 'present' : 'changed');
    }
  }

  return states;
}

/** What is at `target`, following no symlinks. `undefined` only when nothing is there. */
function lstatOf(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch {
    return undefined;
  }
}

/** Total entries across every retained run, for the terminal summary. */
export function countEntries(manifest: ReviewManifest): number {
  return manifest.runs.reduce((total, run) => total + run.entries.length, 0);
}
