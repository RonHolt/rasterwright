import { checkBytes } from './rules/bytes.js';
import { checkColorSpace } from './rules/colorSpace.js';
import { checkDimensions } from './rules/dimensions.js';
import { checkFormat } from './rules/format.js';
import { checkMetadata } from './rules/metadata.js';
import { checkOrientation } from './rules/orientation.js';
import type { RuleContext, RuleOutcome } from './rules/types.js';
import type { EffectiveRule, FileResult, Fixability, ImageInfo, Note, Violation } from '../types.js';

/**
 * Pure: `ImageInfo` + effective rule -> violations and notes.
 *
 * No I/O, no Sharp, no filesystem. This is what makes `check` provably
 * read-only and `--json` free.
 *
 * Check order is fixed so output is stable and diffable.
 */
const CHECKS = [
  checkDimensions,
  checkBytes,
  checkFormat,
  checkMetadata,
  checkColorSpace,
  checkOrientation,
] as const satisfies readonly ((ctx: RuleContext) => RuleOutcome)[];

export function evaluate(info: ImageInfo, rule: EffectiveRule): FileResult {
  const ctx: RuleContext = {
    info,
    body: rule.body,
    sources: rule.sources,
    matchedGlobs: rule.matchedGlobs,
  };

  const violations: Violation[] = [];
  const notes: Note[] = [];
  for (const check of CHECKS) {
    const outcome = check(ctx);
    violations.push(...outcome.violations);
    notes.push(...outcome.notes);
  }

  return {
    path: info.path,
    status: violations.length > 0 ? 'violating' : 'compliant',
    image: info,
    policy: rule.body,
    matchedGlobs: rule.matchedGlobs,
    violations,
    notes: dedupeNotes(notes),
    fixable: aggregateFixability(violations),
  };
}

/**
 * Whether a future `fix` could resolve every violation on a file.
 *
 * Pessimistic: a single unfixable violation makes the file unfixable, and a
 * single undetermined one makes the answer 'unknown'. A file with no
 * violations is trivially 'yes'.
 */
export function aggregateFixability(violations: readonly Violation[]): Fixability {
  if (violations.some((violation) => violation.fixable === 'no')) return 'no';
  if (violations.some((violation) => violation.fixable === 'unknown')) return 'unknown';
  return 'yes';
}

function dedupeNotes(notes: Note[]): Note[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    const key = `${note.code}:${note.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
