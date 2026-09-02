import { INDENT, plural, row } from './common.js';
import { renderOperation } from './plan.js';
import { formatBytes } from '../../utils/bytes.js';
import type { FixReport, FixResult } from '../../types.js';

/**
 * Human-readable and machine-readable `rasterwright fix` output.
 *
 * The plan report answers *what would happen*; this one answers *what
 * happened*, and it is deliberately laid out the other way round. A plan leads
 * with the work it intends to do. A run leads with the work it could not do,
 * because that is the only part the reader has to act on: the fixed files are
 * already correct and need nothing from anybody.
 *
 * So the order is exceptions first - failed, skipped, blocked - then the
 * successes, then the summary. Git warnings and recovery notices are
 * diagnostics rather than sections: they are facts about the run, not about a
 * file, and they go to stderr so a `--json` consumer's stdout stays parseable.
 */

export function renderFixJson(report: FixReport, diagnostics: readonly string[]): string {
  // `FixReport` already carries a `diagnostics` field, so this merges rather
  // than overwrites: the run's own diagnostics and the caller's are the same
  // list from the reader's point of view.
  return JSON.stringify(
    { ...report, diagnostics: [...new Set([...report.diagnostics, ...diagnostics])] },
    null,
    2,
  );
}

const MARKER: Record<FixResult['status'], string> = {
  failed: '✗',
  skipped: '⊘',
  blocked: '⊗',
  fixed: '✓',
  unchanged: '·',
};

export function renderFixHuman(report: FixReport): string {
  const lines: string[] = ['Rasterwright Fix', ''];
  const of = (status: FixResult['status']): FixResult[] =>
    report.results.filter((result) => result.status === status);

  lines.push(...section('FAILED', of('failed'), 'failed'));
  lines.push(...section('SKIPPED', of('skipped'), 'skipped'));
  lines.push(...section('BLOCKED', of('blocked'), 'conflict'));
  lines.push(...section('FIXED', of('fixed'), 'note'));
  lines.push(...renderSummary(report));

  return lines.join('\n');
}

function section(heading: string, results: readonly FixResult[], label: string): string[] {
  if (results.length === 0) return [];
  const lines: string[] = [heading, ''];
  for (const result of results) lines.push(...renderResult(result, label), '');
  return lines;
}

function renderResult(result: FixResult, label: string): string[] {
  const lines: string[] = [`${MARKER[result.status]} ${result.path}`, ''];
  const body: string[] = [];

  // The operations that ran, or - for anything that did not run - the plan it
  // did not run. Seeing what was refused is what makes the refusal actionable.
  const { plan } = result;
  const operations = plan.operations.length > 0 ? plan.operations : plan.blockedOperations;
  // `searched: false`: this report describes encodes that already happened, at
  // one quality each. The downward search belongs to the plan, and to a phase
  // that does not exist yet.
  for (const operation of operations) body.push(...renderOperation(operation, false));

  if (result.status === 'fixed' && result.after !== undefined) {
    body.push(row('size', sizeChange(result)));
  }
  if (result.reason !== undefined) body.push(row(label, result.reason));
  for (const warning of result.warnings) body.push(row('unresolved', warning));
  if (result.status === 'skipped' && plan.requiredPermissions.includes('allowRenames')) {
    body.push(row('permission', 'rerun with --allow-renames'));
  }

  lines.push(...body.map((line) => `${INDENT}${line}`.trimEnd()));
  return lines;
}

/**
 * `412.3 KB -> 88.1 KB  (79% smaller)`.
 *
 * "Larger" is a real outcome and is printed as such: an indexed PNG re-encoded
 * truecolour can come out several times its original size (04 section 17.18),
 * and hiding that behind a signed percentage nobody reads would be a way of not
 * saying it.
 */
function sizeChange(result: FixResult): string {
  const after = result.after;
  if (after === undefined) return formatBytes(result.before.bytes);

  const change = `${formatBytes(result.before.bytes)} -> ${formatBytes(after.bytes)}`;
  const percent = Math.round(result.savingsPct ?? 0);
  if (percent === 0) return `${change}  (no change)`;
  return `${change}  (${Math.abs(percent)}% ${percent > 0 ? 'smaller' : 'larger'})`;
}

function renderSummary(report: FixReport): string[] {
  const { summary } = report;
  const lines = [`${plural(summary.checked, 'image')} inspected`];

  if (summary.fixed > 0) lines.push(`${plural(summary.fixed, 'file')} fixed`);
  if (summary.skipped > 0) lines.push(`${plural(summary.skipped, 'file')} skipped`);
  if (summary.blocked > 0) lines.push(`${plural(summary.blocked, 'file')} blocked by a path conflict`);
  if (summary.failed > 0) lines.push(`${plural(summary.failed, 'file')} failed`);
  lines.push(`${summary.unchanged} already compliant`);

  if (summary.bytesBefore > 0) {
    const saved = summary.bytesBefore - summary.bytesAfter;
    lines.push(
      `${formatBytes(summary.bytesBefore)} -> ${formatBytes(summary.bytesAfter)} ` +
        `across the files that changed (${saved >= 0 ? '' : '+'}${formatBytes(Math.abs(saved))} ${saved >= 0 ? 'saved' : 'added'})`,
    );
  }
  if (summary.ignored > 0) {
    lines.push(
      summary.ignored === 1
        ? '1 image matched no rule and was skipped'
        : `${summary.ignored} images matched no rule and were skipped`,
    );
  }

  lines.push('');

  if (summary.interrupted) {
    lines.push(
      `Interrupted after ${summary.completed} of ${summary.checked} files; ${summary.fixed} fixed.`,
      'Nothing was left half-written. Rerun the same command to continue.',
    );
  }
  for (const path of report.unrecovered) {
    lines.push(`${path} is an image left under an interim name and must be renamed by hand.`);
  }
  if (report.results.some((result) => result.plan.requiredPermissions.includes('allowRenames'))) {
    lines.push('Rerun with --allow-renames to perform the filename changes above.');
  }
  if (report.results.some(isBudgetSkip)) {
    lines.push(
      'Byte budgets are not enforced yet. A plan whose encode exists to meet maxBytes is',
      'reported and skipped until the byte-budget phase lands.',
    );
  }

  return lines;
}

function isBudgetSkip(result: FixResult): boolean {
  return (
    result.status === 'skipped' &&
    result.plan.operations.some((operation) => operation.op === 'encode' && operation.budgetDriven)
  );
}
