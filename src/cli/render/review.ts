import { classify } from '../../review/classify.js';
import { countEntries } from '../../run-review.js';
import { beforeStoreBytes } from '../../review/store.js';
import { formatBytes } from '../../utils/bytes.js';
import { plural } from './common.js';
import type { RunReviewResult } from '../../run-review.js';

/**
 * What `review` says in the terminal.
 *
 * Short on purpose. The page is the output; this is a receipt for it. The one
 * thing worth stating here rather than there is the size of the retained
 * originals, because that is the cost of keeping the page and the reason
 * `--clean` exists.
 */

/** The message for a project no `fix` run has recorded anything in. */
export const NOTHING_RECORDED =
  'no fix run has been recorded in this project, so there is nothing to review; ' +
  'run `rasterwright fix` first';

export function renderReview(result: RunReviewResult, opened: boolean): string {
  if (result.cleaned) return `Removed ${result.reviewDir}.`;
  if (result.manifest === undefined || result.indexPath === undefined) return '';

  const manifest = result.manifest;
  const entries = countEntries(manifest);
  const flagged = manifest.runs.reduce(
    (total, run) => total + run.entries.filter((entry) => classify(entry).length > 0).length,
    0,
  );

  const lines = [result.indexPath, ''];
  lines.push(
    `${plural(entries, 'file')} across ${plural(manifest.runs.length, 'retained run')}, ` +
      `${flagged === 0 ? 'nothing needing attention' : `${flagged} needing attention`}.`,
  );

  const store = beforeStoreBytes(result.reviewDir);
  if (store > 0) {
    lines.push(
      `${formatBytes(store)} of retained originals. ` +
        'Delete them with `rasterwright review --clean` when you are done looking.',
    );
  }
  if (result.collected.length > 0) {
    const count = result.collected.length;
    lines.push(`${count} unreferenced ${count === 1 ? 'copy' : 'copies'} removed.`);
  }
  if (!opened) lines.push('Open the path above in a browser.');

  return lines.join('\n');
}
