import type { CheckReport } from '../../types.js';

/**
 * Machine-readable `check` output.
 *
 * Shape is intentionally flat and boring. This is not a stable public API yet;
 * it exists so a coding agent can read a check result without parsing a table.
 * Every checked file is included, not just the violating ones, because "this
 * file is governed and compliant" is useful information to an agent about to
 * add another image next to it.
 */
export function renderJson(report: CheckReport, diagnostics: string[]): string {
  return JSON.stringify({ ...report, diagnostics }, null, 2);
}
