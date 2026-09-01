import { planFile } from './operations/plan.js';
import { runCheck, type RunCheckOptions } from './run-check.js';
import type { LoadedConfig } from './config/load.js';
import type { CheckReport, FilePlan, FixPermissions, FixPlanReport } from './types.js';

/**
 * The fix-planning pipeline:
 *
 *   check's pipeline -> plan each file -> a report of what fix would do
 *
 * Planning is defined in terms of `check`, which is what makes idempotence fall
 * out rather than have to be engineered: a compliant file produces no findings,
 * no findings produce an empty plan, and an empty plan changes nothing.
 *
 * Still strictly read-only. `operations/execute.ts` does not exist; this build
 * plans and stops.
 */

export interface RunFixPlanOptions extends RunCheckOptions {
  /** `--allow-renames`. Planning permission only; nothing is written either way. */
  allowRenames?: boolean;
}

export interface RunFixPlanResult {
  report: FixPlanReport;
  /** The underlying check, for callers that want the findings behind a plan. */
  check: CheckReport;
  diagnostics: string[];
}

export async function runFixPlan(
  config: LoadedConfig,
  version: string,
  options: RunFixPlanOptions = {},
): Promise<RunFixPlanResult> {
  const permissions: FixPermissions = { allowRenames: options.allowRenames === true };
  const { report: check, diagnostics } = await runCheck(config, version, options);

  const plans = check.files.map((file) => planFile(file, permissions));
  const count = (status: FilePlan['status']): number => plans.filter((plan) => plan.status === status).length;
  const unchanged = plans.filter((plan) => plan.status === 'unchanged');

  const requiresPermission = count('requires-permission');
  const unfixable = count('unfixable');
  const unsupported = count('unsupported');

  const report: FixPlanReport = {
    rasterwrightVersion: version,
    dryRun: true,
    permissions,
    // "Complete" means every error-level finding is covered by a plan this run
    // could actually execute. Warnings are irrelevant to it, exactly as they are
    // to `check`'s exit code.
    complete: requiresPermission + unfixable + unsupported === 0,
    configPath: config.configPath,
    root: config.root,
    summary: {
      checked: plans.length,
      planned: count('planned'),
      requiresPermission,
      unfixable,
      unsupported,
      unchanged: unchanged.length,
      unchangedWithWarnings: unchanged.filter((plan) => plan.warnings.length > 0).length,
      operations: plans.reduce((total, plan) => total + plan.operations.length, 0),
      ignored: check.summary.ignored,
    },
    files: plans.filter((plan) => plan.status !== 'unchanged'),
  };

  return { report, check, diagnostics };
}
