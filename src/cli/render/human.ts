import { formatBytes } from '../../utils/bytes.js';
import type { CheckReport, FileResult, Fixability, Violation } from '../../types.js';

/**
 * Human-readable `check` output.
 *
 * Deliberately plain: no colour, no boxes, no spinner. Correct and scannable
 * beats decorated, and plain text survives being pasted into an issue.
 */

const INDENT = '    ';
const CHECK_COLUMN = 12;
const ACTUAL_COLUMN = 18;

export function renderHuman(report: CheckReport): string {
  const lines: string[] = ['Rasterwright', ''];

  const problems = report.files.filter((file) => file.status !== 'compliant');

  for (const file of problems) {
    lines.push(...renderFile(file), '');
  }

  const notable = report.files.filter((file) => file.status === 'compliant' && file.notes.length > 0);
  for (const file of notable) {
    lines.push(`· ${file.path}`, '');
    for (const note of file.notes) lines.push(`${INDENT}note: ${note.message}`);
    lines.push('');
  }

  lines.push(...renderSummary(report));
  return lines.join('\n');
}

function renderFile(file: FileResult): string[] {
  const lines: string[] = [`✗ ${file.path}`, ''];

  if (file.status === 'error') {
    lines.push(`${INDENT}${file.error ?? 'could not be inspected'}`, '', `${INDENT}not checked`);
    return lines;
  }

  for (const violation of file.violations) {
    lines.push(`${INDENT}${renderViolation(violation)}`);
    if (violation.fixable === 'no') {
      lines.push(`${INDENT}${INDENT}${violation.message}`);
    }
  }

  for (const note of file.notes) {
    lines.push(`${INDENT}note: ${note.message}`);
  }

  lines.push('');
  const count = file.violations.length;
  lines.push(`${INDENT}${count} violation${count === 1 ? '' : 's'}`);
  lines.push(`${INDENT}Fixable: ${fixabilityLabel(file.fixable)}`);
  return lines;
}

function renderViolation(violation: Violation): string {
  const { actual, allowed } = describe(violation);
  return violation.check.padEnd(CHECK_COLUMN) + actual.padEnd(ACTUAL_COLUMN) + allowed;
}

function describe(violation: Violation): { actual: string; allowed: string } {
  switch (violation.check) {
    case 'maxWidth':
    case 'maxHeight':
      return { actual: `${violation.actual} px`, allowed: `allowed: ${violation.allowed} px` };
    case 'maxBytes':
      return {
        actual: formatBytes(Number(violation.actual)),
        allowed: `allowed: ${formatBytes(Number(violation.allowed))}`,
      };
    case 'format':
      return { actual: String(violation.actual), allowed: `expected: ${violation.allowed}` };
    case 'orientation':
      return { actual: String(violation.actual), allowed: `expected: ${violation.allowed} (normal)` };
    default:
      return { actual: String(violation.actual), allowed: `expected: ${violation.allowed}` };
  }
}

function fixabilityLabel(fixable: Fixability): string {
  switch (fixable) {
    case 'yes':
      return 'yes';
    case 'no':
      return 'no';
    case 'unknown':
      return 'unknown (depends on encoding)';
  }
}

function renderSummary(report: CheckReport): string[] {
  const { summary } = report;
  const lines = [
    `${summary.checked} image${summary.checked === 1 ? '' : 's'} checked`,
  ];

  if (summary.violating > 0) {
    lines.push(`${summary.violating} file${summary.violating === 1 ? '' : 's'} with violations`);
  }
  if (summary.errors > 0) {
    lines.push(`${summary.errors} file${summary.errors === 1 ? '' : 's'} could not be inspected`);
  }
  lines.push(`${summary.compliant} compliant`);
  if (summary.ignored > 0) {
    lines.push(
      summary.ignored === 1
        ? '1 image matched no rule and was skipped'
        : `${summary.ignored} images matched no rule and were skipped`,
    );
  }

  if (report.clean) {
    lines.push('', 'No policy violations.');
  }

  return lines;
}
