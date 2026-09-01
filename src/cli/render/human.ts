import { formatBytes } from '../../utils/bytes.js';
import type { CheckReport, FileResult, Finding, Severity } from '../../types.js';

/**
 * Human-readable `check` output.
 *
 * The organising principle, learned from the first run against a real theme:
 *
 *   answer "what should I care about?" before "what did Rasterwright find?"
 *
 * Errors get a block each, because there are usually few and each one needs
 * acting on. Warnings are counted and summarized, because seventeen files
 * carrying harmless EXIF printed as seventeen blocks buried the three files
 * that actually broke the policy. Informational findings are hidden entirely
 * unless asked for. `--verbose` expands everything.
 *
 * Deliberately plain: no colour, no boxes, no spinner. Plain text survives
 * being pasted into an issue.
 */

const INDENT = '    ';
const LABEL_COLUMN = 14;
const ACTUAL_COLUMN = 18;

export interface RenderOptions {
  verbose?: boolean;
}

export function renderHuman(report: CheckReport, options: RenderOptions = {}): string {
  const verbose = options.verbose === true;
  const lines: string[] = ['Rasterwright', ''];

  const errorFiles = report.files.filter((file) => file.status === 'error');
  if (errorFiles.length > 0) {
    lines.push('ERRORS', '');
    for (const file of errorFiles) lines.push(...renderFileBlock(file, 'error'), '');
  }

  const warningFiles = report.files.filter((file) => file.findings.some((f) => f.severity === 'warning'));
  if (warningFiles.length > 0) {
    lines.push('WARNINGS', '');
    if (verbose) {
      for (const file of warningFiles) lines.push(...renderFileBlock(file, 'warning'), '');
    } else {
      lines.push(...summarizeWarnings(warningFiles), '');
    }
  }

  if (verbose) {
    const infoFiles = report.files.filter((file) => file.findings.some((f) => f.severity === 'info'));
    if (infoFiles.length > 0) {
      lines.push('NOTES', '');
      for (const file of infoFiles) lines.push(...renderFileBlock(file, 'info'), '');
    }
  }

  lines.push(...renderSummary(report, verbose));
  return lines.join('\n');
}

const MARKER: Record<Severity, string> = { error: '✗', warning: '⚠', info: '·' };

function renderFileBlock(file: FileResult, severity: Severity): string[] {
  const findings = file.findings.filter((finding) => finding.severity === severity);
  if (findings.length === 0) return [];

  const lines: string[] = [`${MARKER[severity]} ${file.path}`, ''];
  for (const finding of findings) {
    lines.push(...renderFinding(finding).map((line) => (line === '' ? '' : `${INDENT}${line}`.trimEnd())));
  }
  return lines;
}

function renderFinding(finding: Finding): string[] {
  const lines: string[] = [];

  switch (finding.check) {
    case 'decode':
      lines.push(pad('unreadable') + finding.message);
      return lines;

    case 'extension':
      // Two lines, because "actual vs allowed" reads backwards here: neither
      // side is a limit, they are two claims about the same file.
      lines.push(pad('extension') + String(finding.allowed));
      lines.push(pad('contents') + String(finding.actual));
      lines.push('');
      lines.push('File extension does not match the encoded image format.');
      return lines;

    default: {
      const { actual, allowed } = describe(finding);
      lines.push(pad(finding.check) + actual.padEnd(ACTUAL_COLUMN) + allowed);
      break;
    }
  }

  const supplement = supplementFor(finding);
  if (supplement !== undefined) lines.push(supplement);

  return lines;
}

/**
 * The one extra line a finding gets, when the columns do not already say it.
 *
 * For an unmeetable byte budget this is deliberately not "Fixable: unknown".
 * `check` does not encode, so it cannot know; naming the next step is more use
 * than reporting our own uncertainty.
 */
function supplementFor(finding: Finding): string | undefined {
  if (finding.fixable === 'no') return `Not safely fixable: ${finding.message}`;
  if (finding.fixable === 'unknown') return 'Fix requires encoding';
  // These two carry detail the actual/allowed columns cannot show.
  if (finding.check === 'format' || finding.check === 'orientation') return finding.message;
  return undefined;
}

function pad(label: string): string {
  return label.padEnd(LABEL_COLUMN);
}

function describe(finding: Finding): { actual: string; allowed: string } {
  switch (finding.check) {
    case 'maxWidth':
    case 'maxHeight':
      return { actual: `${finding.actual} px`, allowed: `allowed: ${finding.allowed} px` };
    case 'maxBytes':
      return {
        actual: formatBytes(Number(finding.actual)),
        allowed: `allowed: ${formatBytes(Number(finding.allowed))}`,
      };
    case 'orientation':
      return { actual: String(finding.actual), allowed: `expected: ${finding.allowed} (normal)` };
    case 'metadata':
      return { actual: String(finding.actual), allowed: 'a fix would remove it' };
    default:
      if (finding.actual === null) return { actual: finding.message, allowed: '' };
      return { actual: String(finding.actual), allowed: `expected: ${finding.allowed}` };
  }
}

/**
 * Collapse repetitive warnings into counts.
 *
 * Grouped by check, then, for metadata, broken down by which kinds are present -
 * "17 images contain removable metadata" is the actionable sentence, and the
 * breakdown says how much of it is which.
 */
function summarizeWarnings(files: readonly FileResult[]): string[] {
  const byCheck = new Map<string, FileResult[]>();
  for (const file of files) {
    for (const check of new Set(file.findings.filter((f) => f.severity === 'warning').map((f) => f.check))) {
      const bucket = byCheck.get(check) ?? [];
      bucket.push(file);
      byCheck.set(check, bucket);
    }
  }

  const lines: string[] = [];
  for (const [check, bucket] of byCheck) {
    if (check === 'metadata') {
      lines.push(`⚠ ${plural(bucket.length, 'image')} contain removable metadata`);
      for (const [kind, count] of tallyMetadataKinds(bucket)) {
        lines.push(`${INDENT}${count} ${kind}`);
      }
    } else {
      lines.push(`⚠ ${plural(bucket.length, 'image')}: ${check}`);
    }
  }

  lines.push('', `${INDENT}Run with --verbose to list them.`);
  return lines;
}

function tallyMetadataKinds(files: readonly FileResult[]): Array<[string, number]> {
  const tally = new Map<string, number>();
  for (const file of files) {
    for (const finding of file.findings) {
      if (finding.check !== 'metadata' || finding.severity !== 'warning') continue;
      for (const kind of String(finding.actual).split(', ')) {
        tally.set(kind, (tally.get(kind) ?? 0) + 1);
      }
    }
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function renderSummary(report: CheckReport, verbose: boolean): string[] {
  const { summary } = report;
  const lines = [`${plural(summary.checked, 'image')} checked`];

  if (summary.withErrors > 0) {
    lines.push(`${plural(summary.withErrors, 'file')} with errors`);
  }
  if (summary.unreadable > 0) {
    lines.push(`${plural(summary.unreadable, 'file')} could not be inspected`);
  }
  if (summary.withWarnings > 0) {
    lines.push(`${plural(summary.withWarnings, 'file')} with warnings`);
  }
  lines.push(`${summary.clean} clean`);

  if (summary.infos > 0 && !verbose) {
    lines.push(`${plural(summary.infos, 'informational note')} (--verbose to show)`);
  }
  if (summary.ignored > 0) {
    lines.push(
      summary.ignored === 1
        ? '1 image matched no rule and was skipped'
        : `${summary.ignored} images matched no rule and were skipped`,
    );
  }

  if (report.clean) {
    lines.push('', summary.withWarnings > 0 ? 'No errors.' : 'No errors or warnings.');
  }

  return lines;
}
