import fs from 'node:fs';

import { planFile } from './operations/plan.js';
import { defaultPathSemantics, validatePlanSet, type PathSemantics } from './operations/plan-set.js';
import { runCheck, type RunCheckOptions } from './run-check.js';
import { toAbsolute } from './utils/paths.js';
import type { LoadedConfig } from './config/load.js';
import type { CheckReport, FilePlan, FixPermissions, FixPlanReport } from './types.js';

/**
 * The fix-planning pipeline:
 *
 *   check's pipeline -> plan each file -> preflight the whole set -> a report
 *
 * Planning is defined in terms of `check`, which is what makes idempotence fall
 * out rather than have to be engineered: a compliant file produces no findings,
 * no findings produce an empty plan, and an empty plan changes nothing.
 *
 * Preflight is the one step that is *not* file-local, and it exists because two
 * individually correct plans can still destroy a file between them. It runs
 * before anything is reported, so `complete` means "this whole batch could be
 * executed", not "each file looked fine on its own".
 *
 * Still strictly read-only. `operations/execute.ts` does not exist; this build
 * plans and stops. The only filesystem access preflight adds is `lstatSync` on
 * paths a rename would land on.
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
  const { report: check, discovered, diagnostics: checkDiagnostics } = await runCheck(
    config,
    version,
    options,
  );

  const planned = check.files.map((file) => planFile(file, permissions));
  const semantics = defaultPathSemantics();
  const survey = surveyTargets(config.root, planned, discovered, semantics);
  const preflight = validatePlanSet(planned, survey.paths, semantics, survey.unprobeable);
  const diagnostics = [...checkDiagnostics, ...survey.diagnostics];

  const plans = preflight.plans;
  const count = (status: FilePlan['status']): number => plans.filter((plan) => plan.status === status).length;
  const unchanged = plans.filter((plan) => plan.status === 'unchanged');

  const requiresPermission = count('requires-permission');
  const blocked = count('blocked');
  const unfixable = count('unfixable');
  const unsupported = count('unsupported');

  const report: FixPlanReport = {
    rasterwrightVersion: version,
    dryRun: true,
    permissions,
    // "Complete" means every error-level finding is covered by a plan this run
    // could actually execute. A plan preflight refused is not one of those, so
    // a collision fails the run exactly as a missing permission does. Warnings
    // are irrelevant to it, exactly as they are to `check`'s exit code.
    complete: requiresPermission + blocked + unfixable + unsupported === 0,
    configPath: config.configPath,
    root: config.root,
    summary: {
      checked: plans.length,
      planned: count('planned'),
      requiresPermission,
      blocked,
      unfixable,
      unsupported,
      unchanged: unchanged.length,
      unchangedWithWarnings: unchanged.filter((plan) => plan.warnings.length > 0).length,
      operations: plans.reduce((total, plan) => total + plan.operations.length, 0),
      ignored: check.summary.ignored,
    },
    conflicts: preflight.conflicts,
    files: plans.filter((plan) => plan.status !== 'unchanged'),
  };

  return { report, check, diagnostics };
}

interface TargetSurvey {
  /** Every path preflight should treat as already taken. */
  paths: string[];
  /** Targets that could not be probed, with the errno that stopped it. */
  unprobeable: [string, string][];
  diagnostics: string[];
}

/**
 * Every path that exists before the run, as far as preflight needs to know.
 *
 * Two sources, in this order:
 *
 *   1. the scan discovery already performed. It walked the tree once, so every
 *      image file in the project is known for free.
 *   2. an `lstatSync` per rename target the scan did not already cover.
 *
 * The second is necessary because a rename target need not be an image: a
 * directory, a symlink, a `.txt` file or a git-ignored image all occupy the
 * name, and renaming onto any of them is data loss. `lstat` rather than `stat`
 * so a dangling symlink still counts as occupied - resolving the link would
 * report the name as free and then clobber the link itself.
 *
 * ## A probe that fails is not a probe that passed
 *
 * `throwIfNoEntry: false` turns the answer Rasterwright actually wants -
 * "nothing is there" - into `undefined`. Every *other* errno is a real failure
 * and still throws: `EACCES` on an unreadable parent directory, `ENOTDIR` when
 * a path component is a file, `ELOOP` on a symlink cycle, `ENAMETOOLONG` when
 * the new extension pushes a filename past the filesystem's limit. None of
 * those mean the path is free, and none of them should surface as a stack
 * trace, so each one blocks its plan with the errno named.
 *
 * This is the only filesystem access fix planning adds beyond `check`, and it
 * opens nothing.
 */
function surveyTargets(
  root: string,
  plans: readonly FilePlan[],
  discovered: readonly string[],
  semantics: PathSemantics,
): TargetSurvey {
  const fold = (value: string): string =>
    semantics === 'case-insensitive' ? value.toLowerCase() : value;

  const survey: TargetSurvey = { paths: [...discovered], unprobeable: [], diagnostics: [] };
  const known = new Set(survey.paths.map(fold));

  for (const plan of plans) {
    if (plan.status !== 'planned' || plan.targetPath === plan.path) continue;
    if (known.has(fold(plan.targetPath))) continue;
    known.add(fold(plan.targetPath));

    const absolute = toAbsolute(root, plan.targetPath);
    let stats: fs.Stats | undefined;
    try {
      stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    } catch (error) {
      const code = errnoOf(error);
      survey.unprobeable.push([plan.targetPath, code]);
      survey.diagnostics.push(
        `could not check whether ${plan.targetPath} exists (${code}); ` +
          `${plan.path} is blocked rather than assumed safe`,
      );
      continue;
    }

    if (stats === undefined) continue;
    survey.paths.push(onDiskSpelling(root, plan.targetPath, semantics));
  }

  return survey;
}

/**
 * The spelling the filesystem actually holds, where that can differ.
 *
 * On a case-insensitive filesystem `lstat('a/LOGO.WEBP')` succeeds against a
 * file stored as `a/logo.webp`, and recording the spelling we asked for would
 * report a case-only collision as an exact one. Reading the parent directory is
 * the only way to learn the truth, and it is read-only.
 *
 * Falls back to the requested spelling whenever the directory cannot be read.
 * The path is occupied either way; only the wording of the message suffers.
 */
function onDiskSpelling(root: string, relativePath: string, semantics: PathSemantics): string {
  if (semantics !== 'case-insensitive') return relativePath;

  const cut = relativePath.lastIndexOf('/');
  const directory = cut === -1 ? '' : relativePath.slice(0, cut);
  const name = relativePath.slice(cut + 1);

  try {
    const entries = fs.readdirSync(toAbsolute(root, directory === '' ? '.' : directory));
    const actual = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (actual === undefined) return relativePath;
    return directory === '' ? actual : `${directory}/${actual}`;
  } catch {
    return relativePath;
  }
}

/** The errno of a filesystem failure, or a stable placeholder for anything else. */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'unknown error';
}
