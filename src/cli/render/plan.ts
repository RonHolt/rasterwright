import { formatBytes } from '../../utils/bytes.js';
import type { FilePlan, FixPlanReport, PlannedOperation } from '../../types.js';

/**
 * Human-readable and machine-readable `fix --dry-run` output.
 *
 * The organising principle is the same as `check`'s report, one step further
 * along: answer *what would happen, and what is stopping it?* Files are grouped
 * by what a fix run would do to them rather than by which rule they broke, so
 * "three files would change, one is waiting on me" is readable at a glance.
 *
 * The one thing this output must never do is imply a result. Planning has not
 * encoded anything, so an encode against a byte ceiling prints a target and the
 * fact that the outcome has to be verified, never a predicted size.
 */

const INDENT = '    ';
const LABEL_COLUMN = 14;

export function renderPlanJson(report: FixPlanReport, diagnostics: string[]): string {
  return JSON.stringify({ ...report, diagnostics }, null, 2);
}

export function renderPlanHuman(report: FixPlanReport): string {
  const lines: string[] = ['Rasterwright Fix Plan', ''];

  lines.push(...section('WOULD FIX', report.files.filter((plan) => plan.status === 'planned')));
  lines.push(
    ...section('REQUIRES PERMISSION', report.files.filter((plan) => plan.status === 'requires-permission')),
  );
  lines.push(
    ...section(
      'CANNOT FIX',
      report.files.filter((plan) => plan.status === 'unfixable' || plan.status === 'unsupported'),
    ),
  );

  const { summary } = report;
  if (summary.unchangedWithWarnings > 0) {
    lines.push(
      'LEFT UNCHANGED',
      '',
      `${plural(summary.unchangedWithWarnings, 'image')} carry warnings only`,
      '',
      `${INDENT}Metadata is normalized during a rewrite an error already required,`,
      `${INDENT}never as a reason to rewrite a compliant file.`,
      '',
    );
  }

  lines.push(...renderSummary(report));
  return lines.join('\n');
}

function section(heading: string, plans: readonly FilePlan[]): string[] {
  if (plans.length === 0) return [];
  const lines: string[] = [heading, ''];
  for (const plan of plans) lines.push(...renderPlan(plan), '');
  return lines;
}

const MARKER: Record<FilePlan['status'], string> = {
  planned: '→',
  'requires-permission': '⊘',
  unfixable: '✗',
  unsupported: '✗',
  unchanged: '·',
};

function renderPlan(plan: FilePlan): string[] {
  const lines: string[] = [`${MARKER[plan.status]} ${plan.path}`, ''];
  const body: string[] = [];

  // A blocked file shows the plan it is waiting on. Seeing "rename .png ->
  // .webp, no re-encode required" is what makes granting permission a decision
  // rather than a leap.
  const operations = plan.status === 'planned' ? plan.operations : plan.blockedOperations;
  for (const operation of operations) body.push(...renderOperation(operation));

  if (plan.normalizedDuringRewrite.includes('metadata')) {
    body.push(row('metadata', 'strip during the rewrite above'));
  }
  // Read off the operations actually being shown, so a blocked plan is as
  // honest about its unknowns as one this run could execute.
  if (operations.some((operation) => operation.op === 'encode' && operation.outcomeRequiresVerification)) {
    body.push(row('result', 'must be verified during execution'));
  }
  for (const note of plan.notes) body.push(row('note', note));
  for (const reason of plan.reasons) body.push(row(labelFor(plan), reason));
  if (plan.requiredPermissions.includes('allowRenames')) {
    body.push(row('permission', 'rerun with --allow-renames'));
  }

  lines.push(...body.map((line) => `${INDENT}${line}`.trimEnd()));
  return lines;
}

function labelFor(plan: FilePlan): string {
  return plan.status === 'requires-permission' ? 'blocked' : 'reason';
}

function renderOperation(operation: PlannedOperation): string[] {
  switch (operation.op) {
    case 'autoOrient':
      return [
        row(
          'auto-orient',
          `EXIF orientation ${operation.orientation}: ` +
            `${dimensions(operation.from)} stored, ${dimensions(operation.to)} displayed`,
        ),
      ];

    case 'resize':
      return [row('resize', `${dimensions(operation.from)} -> ${dimensions(operation.to)}`)];

    case 'toColorSpace':
      return [row('color space', `${operation.from} -> sRGB`)];

    case 'encode': {
      const lines = [row('encode', FORMAT_LABEL[operation.format])];
      if (operation.maxBytes !== undefined) {
        // "target" when the budget is why we are encoding; "ceiling" when it is
        // a limit that merely also applies to a rewrite something else required.
        lines.push(
          row(operation.budgetDriven ? 'target' : 'ceiling', `<= ${formatBytes(operation.maxBytes)}`),
        );
      }
      if (operation.quality !== undefined) {
        lines.push(
          row(
            'quality',
            operation.maxBytes === undefined
              ? `${operation.quality.start}`
              : `${operation.quality.start}, searched down to ${operation.quality.floor} if needed`,
          ),
        );
      }
      if (operation.preserveAlpha) lines.push(row('transparency', 'preserve'));
      if (operation.lossyReencode) {
        lines.push(row('re-encode', 'lossy source re-encoded; some generation loss'));
      }
      return lines;
    }

    case 'rename': {
      const lines = [row('rename', `${extensionOf(operation.from)} -> ${extensionOf(operation.to)}`)];
      lines.push(row('path', operation.to));
      if (!operation.reencode) {
        lines.push(row('pixels', 'already in the target format; no re-encode required'));
      }
      return lines;
    }
  }
}

const FORMAT_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' } as const;

function extensionOf(filePath: string): string {
  const index = filePath.lastIndexOf('.');
  return index === -1 ? filePath : filePath.slice(index);
}

function dimensions({ width, height }: { width: number; height: number }): string {
  return `${width}x${height}`;
}

/** `label   value`, wrapping to a second line rather than colliding. */
function row(label: string, value: string): string {
  return label.padEnd(LABEL_COLUMN) + value;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function renderSummary(report: FixPlanReport): string[] {
  const { summary } = report;
  const lines = [`${plural(summary.checked, 'image')} inspected`];

  if (summary.planned > 0) {
    lines.push(`${plural(summary.planned, 'file')} would be modified`);
  }
  if (summary.requiresPermission > 0) {
    lines.push(
      `${plural(summary.requiresPermission, 'file')} ${summary.requiresPermission === 1 ? 'requires' : 'require'} permission`,
    );
  }
  if (summary.unfixable > 0) {
    lines.push(`${plural(summary.unfixable, 'file')} cannot be fixed safely`);
  }
  if (summary.unsupported > 0) {
    lines.push(`${plural(summary.unsupported, 'file')} unsupported in v0`);
  }
  if (summary.unchangedWithWarnings > 0) {
    lines.push(`${plural(summary.unchangedWithWarnings, 'warning-only file')} left unchanged`);
  }
  lines.push(`${summary.unchanged - summary.unchangedWithWarnings} already compliant`);
  if (summary.ignored > 0) {
    lines.push(
      summary.ignored === 1
        ? '1 image matched no rule and was skipped'
        : `${summary.ignored} images matched no rule and were skipped`,
    );
  }

  lines.push('');
  lines.push('Nothing was written. This is a plan, not a run.');
  if (!report.permissions.allowRenames && report.summary.requiresPermission > 0) {
    lines.push('Rerun with --allow-renames to plan the filename changes above.');
  }
  lines.push('Executing a plan is not implemented yet.');

  return lines;
}
