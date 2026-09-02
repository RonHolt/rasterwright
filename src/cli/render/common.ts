/**
 * Layout primitives shared by the plan report and the fix report.
 *
 * The two reports describe the same operations at different moments - one
 * before anything happened, one after - so they have to look like the same
 * tool. Keeping the indent, the label column and the pluralizer in one place is
 * what stops them drifting apart a line at a time.
 */

/** Indent applied to every detail line under a file heading. */
export const INDENT = '    ';

/** Width of the label column, so values line up across every kind of row. */
export const LABEL_COLUMN = 14;

/** `label   value`. A label longer than the column simply pushes its value along. */
export function row(label: string, value: string): string {
  return label.padEnd(LABEL_COLUMN) + value;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function dimensions({ width, height }: { width: number; height: number }): string {
  return `${width}x${height}`;
}
