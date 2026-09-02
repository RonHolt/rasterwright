import { checkBytes } from './rules/bytes.js';
import { checkColorSpace } from './rules/colorSpace.js';
import { checkDimensions } from './rules/dimensions.js';
import { checkExtension } from './rules/extension.js';
import { checkFormat } from './rules/format.js';
import { checkMetadata } from './rules/metadata.js';
import { checkOrientation } from './rules/orientation.js';
import type { RuleContext } from './rules/types.js';
import type { EffectiveRule, FileResult, FileStatus, Finding, Fixability, ImageInfo } from '../types.js';

/**
 * Pure: `ImageInfo` + effective rule -> findings.
 *
 * No I/O, no Sharp, no filesystem. This is what makes `check` provably
 * read-only and `--json` free.
 *
 * Check order is fixed so output is stable and diffable.
 */
const CHECKS = [
  checkDimensions,
  checkBytes,
  checkExtension,
  checkFormat,
  checkMetadata,
  checkColorSpace,
  checkOrientation,
] as const satisfies readonly ((ctx: RuleContext) => Finding[])[];

/**
 * `allGlobs` defaults to the globs that matched, which is the honest answer
 * when a caller has nothing else to offer: those are the only rules it knows
 * about. Production always passes the whole policy.
 */
export function evaluate(
  info: ImageInfo,
  rule: EffectiveRule,
  allGlobs: string[] = rule.matchedGlobs,
): FileResult {
  const ctx: RuleContext = {
    info,
    body: rule.body,
    sources: rule.sources,
    matchedGlobs: rule.matchedGlobs,
    allGlobs,
  };

  const findings = dedupe(CHECKS.flatMap((check) => check(ctx)));

  return {
    path: info.path,
    status: statusOf(findings),
    image: info,
    policy: rule.body,
    matchedGlobs: rule.matchedGlobs,
    findings,
    fixable: aggregateFixability(findings),
  };
}

/** A file's status is the highest severity it produced. */
export function statusOf(findings: readonly Finding[]): FileStatus {
  if (findings.some((finding) => finding.severity === 'error')) return 'error';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  if (findings.length > 0) return 'info';
  return 'clean';
}

/**
 * Whether `fix` could resolve everything actionable on a file.
 *
 * Informational findings are excluded: there is nothing to fix about an image
 * simply having transparency. Otherwise pessimistic - a single unfixable
 * finding makes the file unfixable, and a single undetermined one makes the
 * answer 'unknown'.
 */
export function aggregateFixability(findings: readonly Finding[]): Fixability {
  const actionable = findings.filter((finding) => finding.severity !== 'info');
  if (actionable.some((finding) => finding.fixable === 'no')) return 'no';
  if (actionable.some((finding) => finding.fixable === 'unknown')) return 'unknown';
  return 'yes';
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.check}:${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
