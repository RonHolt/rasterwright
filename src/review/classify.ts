import type { PlannedOperation, ReviewEntry, ReviewFlag } from '../types.js';

/**
 * Why one file is worth looking at.
 *
 * A pure function over a `ReviewEntry`, deliberately separate from the page: the
 * thresholds below are the judgement calls in this whole phase, and they should
 * be readable and testable in one place rather than spread through string
 * templates. Nothing here reads the filesystem or the manifest.
 *
 * The flags are computed at render time rather than stored, so changing a
 * threshold changes what an existing manifest says without rewriting it.
 */

/** How the "needs attention" section is ordered. Earlier is more urgent. */
export const FLAG_ORDER: readonly ReviewFlag[] = [
  'failed',
  'blocked',
  'skipped',
  'unmet-budget',
  'transparency',
  'unresolved',
  'renamed',
  'grew',
  'barely-shrank',
  'shrank-suspiciously',
  'quality-only-drop',
  'dimensions-without-resize',
];

/** One sentence per flag, shown on the card. */
export const FLAG_LABELS: Record<ReviewFlag, string> = {
  failed: 'failed; the original is untouched',
  blocked: 'blocked by a path conflict',
  skipped: 'skipped',
  'unmet-budget': 'a byte ceiling was not met',
  transparency: 'transparency decided the outcome',
  unresolved: 'something is still outstanding after the write',
  renamed: 'the filename changed',
  grew: 'the output is larger than the input',
  'barely-shrank': 'a lossy re-encode that saved almost nothing',
  'shrank-suspiciously': 'a very large saving, worth confirming by eye',
  'quality-only-drop': 'a large saving from quality alone, with no resize',
  'dimensions-without-resize': 'the dimensions changed with no resize planned',
};

/** Savings above this are large enough to be worth confirming by eye. */
const SUSPICIOUS_SAVING = 95;

/** A saving this large with no resize behind it came entirely out of quality. */
const QUALITY_ONLY_SAVING = 70;

/** Below this, a lossy re-encode spent generation loss for nothing. */
const NEGLIGIBLE_SAVING = 2;

export function classify(entry: ReviewEntry): ReviewFlag[] {
  const flags = new Set<ReviewFlag>();
  const encode = operationOf(entry.operations, 'encode');
  const text = `${entry.reason ?? ''} ${entry.warnings.join(' ')}`;

  if (entry.status === 'failed') flags.add('failed');
  if (entry.status === 'blocked') flags.add('blocked');
  if (entry.status === 'skipped') flags.add('skipped');

  // Error-level findings the write did not resolve. Only a pixel-free rename
  // produces these, and it is precisely the case where the file is now named
  // correctly and is still wrong inside, which nothing else would say.
  if (entry.warnings.length > 0) flags.add('unresolved');

  if (entry.outputPath !== entry.path) flags.add('renamed');

  // A ceiling the run could not reach. The encode's own `maxBytes` is the
  // reliable signal for a refusal; the second clause catches a written file over
  // its ceiling, which verification should make impossible and which is
  // therefore exactly the thing worth seeing if it ever happens.
  if (encode?.maxBytes !== undefined) {
    if (entry.status === 'failed') flags.add('unmet-budget');
    if (entry.after !== undefined && entry.after.bytes > encode.maxBytes) flags.add('unmet-budget');
  }
  if (entry.status !== 'fixed' && /\bmaxBytes\b|ceiling|budget/i.test(text)) {
    flags.add('unmet-budget');
  }

  // Only a judgement call counts. An alpha-preserving encode that succeeded made
  // no decision worth reviewing; a file Rasterwright declined to convert because
  // JPEG cannot hold its transparency did.
  if (entry.status !== 'fixed' && /transparen|alpha/i.test(text)) flags.add('transparency');

  const savings = entry.savingsPct;
  if (savings !== undefined && entry.after !== undefined) {
    if (savings < 0) flags.add('grew');
    if (savings > SUSPICIOUS_SAVING) flags.add('shrank-suspiciously');
    if (savings > QUALITY_ONLY_SAVING && !entry.applied.includes('resize')) {
      flags.add('quality-only-drop');
    }
    if (savings >= 0 && savings < NEGLIGIBLE_SAVING && encode?.lossyReencode === true) {
      flags.add('barely-shrank');
    }
    const resized = entry.applied.includes('resize') || entry.applied.includes('autoOrient');
    if (!resized && (entry.after.width !== entry.before.width || entry.after.height !== entry.before.height)) {
      flags.add('dimensions-without-resize');
    }
  }

  return FLAG_ORDER.filter((flag) => flags.has(flag));
}

/** True when this entry belongs in the "needs attention" section. */
export function needsAttention(entry: ReviewEntry): boolean {
  return classify(entry).length > 0;
}

export function operationOf<K extends PlannedOperation['op']>(
  operations: readonly PlannedOperation[],
  op: K,
): Extract<PlannedOperation, { op: K }> | undefined {
  return operations.find((candidate): candidate is Extract<PlannedOperation, { op: K }> =>
    candidate.op === op,
  );
}
