import type { CheckReport } from '../../types.js';

/**
 * Machine-readable `check` output.
 *
 * Exhaustive on purpose, and the opposite of the human report: where that
 * summarizes to stay readable, this lists every finding on every checked file,
 * compliant ones included, because "this file is governed and passes" is useful
 * to an agent about to add another image next to it.
 *
 * Every finding carries `severity` (error / warning / info) and `fixability`
 * (yes / no / unknown / n/a), so a caller can tell a hard failure from a
 * normalization preference, and a safe fix from one that needs a human.
 *
 * Shape is intentionally flat and boring, and is not a stable public API yet.
 */
export function renderJson(report: CheckReport, diagnostics: string[]): string {
  return JSON.stringify({ ...report, diagnostics }, null, 2);
}
