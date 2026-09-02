import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { recoverInterruptedMoves, sweepStaleTemps, TempRegistry } from './operations/atomic.js';
import { resolveBackupDir } from './operations/backup.js';
import {
  executeFile,
  skipReasonFor,
  INTERRUPTED_REASON,
  type ExecuteContext,
} from './operations/execute.js';
import { classifyPath, surveyGit } from './operations/git.js';
import { planFile } from './operations/plan.js';
import { defaultPathSemantics, validatePlanSet, type PathSemantics } from './operations/plan-set.js';
import { createResolver } from './config/resolve.js';
import { engineVersions } from './scanner/inspect.js';
import { runCheck, type RunCheckOptions } from './run-check.js';
import { defaultConcurrency, mapWithConcurrency } from './utils/concurrency.js';
import { RasterwrightError } from './utils/errors.js';
import { toAbsolute } from './utils/paths.js';
import { createStopFlag, installStopHandlers } from './utils/signal.js';
import type { LoadedConfig } from './config/load.js';
import type {
  CheckReport,
  FilePlan,
  FixPermissions,
  FixPlanReport,
  FixReport,
  FixResult,
  PlanSetConflict,
} from './types.js';

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
 * `planRun` and `runFixPlan` are strictly read-only: the only filesystem access
 * preflight adds beyond `check` is `lstatSync` on paths a rename would land on.
 * `runFix` is the one function in this file that writes, and everything it
 * writes goes through `operations/execute.ts` and `operations/atomic.ts`.
 */

export interface RunFixPlanOptions extends RunCheckOptions {
  /** `--allow-renames`. Planning permission only; nothing is written either way. */
  allowRenames?: boolean;
  /** How the filesystem compares two paths. Defaults to the platform's. */
  semantics?: PathSemantics;
}

export interface RunFixPlanResult {
  report: FixPlanReport;
  /** The underlying check, for callers that want the findings behind a plan. */
  check: CheckReport;
  diagnostics: string[];
}

export interface PlanRunResult {
  /** Every governed file's plan, in check order, as batch preflight left it. */
  plans: FilePlan[];
  conflicts: PlanSetConflict[];
  /** The underlying check, for callers that want the findings behind a plan. */
  check: CheckReport;
  diagnostics: string[];
  /** The permissions this run was granted, as the plans were built with them. */
  permissions: FixPermissions;
}

/**
 * Everything that has to happen before anything could be written: check, plan
 * each file, preflight the whole set.
 *
 * Split out from report construction because execution needs exactly this and
 * nothing else. Duplicating it would mean duplicating `surveyTargets`, which is
 * where all the `lstat` conservatism about occupied paths lives, and an executor
 * running against a plan set a different preflight approved is not the plan the
 * dry run described.
 *
 * Read-only, as `fix --dry-run` is: the only filesystem access beyond `check`'s
 * is `lstatSync` on paths a rename would land on.
 */
export async function planRun(
  config: LoadedConfig,
  version: string,
  options: RunFixPlanOptions = {},
): Promise<PlanRunResult> {
  const permissions: FixPermissions = { allowRenames: options.allowRenames === true };
  const { report: check, discovered, diagnostics: checkDiagnostics } = await runCheck(
    config,
    version,
    options,
  );

  // The resolver is handed to the planner so a plan that moves a file can read
  // the policy of where it is going. `resolve` is a pure function of the loaded
  // config, so planning stays deterministic and filesystem-free.
  const resolver = createResolver(config.policy);
  const planned = check.files.map((file) =>
    planFile(file, permissions, { ruleFor: (path) => resolver.resolve(path) }),
  );
  // Taken from the caller when there is one, so a run derives path semantics
  // exactly once and preflight, the executor, the recovery pass and every
  // rename are guaranteed to be answering the same question the same way.
  const semantics = options.semantics ?? defaultPathSemantics();
  const survey = surveyTargets(config.root, planned, discovered, semantics);
  const preflight = validatePlanSet(planned, survey.paths, semantics, survey.unprobeable);

  return {
    plans: preflight.plans,
    conflicts: preflight.conflicts,
    check,
    diagnostics: [...checkDiagnostics, ...survey.diagnostics],
    permissions,
  };
}

export async function runFixPlan(
  config: LoadedConfig,
  version: string,
  options: RunFixPlanOptions = {},
): Promise<RunFixPlanResult> {
  const { plans, conflicts, check, diagnostics, permissions } = await planRun(config, version, options);

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
    conflicts,
    files: plans.filter((plan) => plan.status !== 'unchanged'),
  };

  return { report, check, diagnostics };
}

export interface RunFixOptions extends RunFixPlanOptions {
  /** `--no-git`: proceed outside a repository, accepting that there is no undo. */
  noGit?: boolean;
  /** `--backup-dir`: copy each original here before overwriting it. */
  backupDir?: string;
}

export interface RunFixResult {
  report: FixReport;
  diagnostics: string[];
}

/**
 * Execute a plan set.
 *
 * The ordering below is the safety property, not an implementation detail:
 *
 *   1. validate `--backup-dir`
 *   2. plan (read-only)
 *   3. the git precondition
 *   4. recover interrupted renames, then sweep stale temp files
 *   5. install the signal handlers
 *   6. execute, with bounded concurrency
 *   7. clean up, uninstall, report
 *
 * Steps 4 onward write. Steps 1 to 3 must therefore come first, or a run that
 * refuses because it is outside a repository has still modified the tree, and
 * "Rasterwright refused and changed nothing" stops being true.
 */
export async function runFix(
  config: LoadedConfig,
  version: string,
  options: RunFixOptions = {},
): Promise<RunFixResult> {
  // 1. Validation only. It creates nothing: a run that is about to be refused
  //    for another reason, or that turns out to have nothing to write, must not
  //    leave a directory behind. The copies create it on the first write.
  const backupDir =
    options.backupDir === undefined ? undefined : resolveBackupDir(config.root, options.backupDir);

  // 2. The same preflight the dry run reports, so the executor runs against the
  //    plan set the dry run described rather than one a second preflight built.
  //    Path semantics are derived once, here, and handed to everything that
  //    compares two paths: preflight, the executor, recovery and every rename.
  const semantics = options.semantics ?? defaultPathSemantics();
  const { plans, conflicts, check, diagnostics, permissions } = await planRun(config, version, {
    ...options,
    semantics,
  });
  const before = new Map(check.files.map((file) => [file.path, file]));

  // Only the plans this run will actually execute. A file the run will not open
  // for writing must not make git warn about a risk that does not exist, and
  // must not get its directory swept, which is a write nothing asked for. The
  // same predicate the executor uses, so the two can never disagree about which
  // files are in scope.
  const executing = plans.filter(
    (plan) => plan.status === 'planned' && skipReasonFor(plan) === undefined,
  );

  // 3. Git is the undo mechanism (04 section 8), so its absence is a refusal
  //    rather than a warning unless the user has said otherwise.
  diagnostics.push(...gitPreconditions(config.root, executing, options, backupDir));

  const registry = new TempRegistry();
  const stop = createStopFlag();

  // 4. Residue from an earlier run that ended abruptly, in the directories this
  //    run is about to write to and nowhere else. Recovery first: an image under
  //    an interim name must be put back before anything observes its intended
  //    name as free.
  const directories = writeDirectories(config.root, executing);
  const recovery = await recoverInterruptedMoves(directories, semantics);
  for (const recovered of recovery.recovered) {
    diagnostics.push(`recovered ${recovered} from a rename an earlier run did not finish`);
  }
  for (const stranded of recovery.needsAttention) {
    diagnostics.push(
      `${stranded} is an image left behind by an interrupted rename, and its intended name is ` +
        'occupied; it has been left exactly as it is and must be renamed by hand',
    );
  }
  // Deliberately neutral about how it got there. A temp file whose owning
  // process is gone is residue from an earlier run, and Rasterwright has no way
  // to know whether that run was killed, crashed, or lost its machine.
  for (const swept of await sweepStaleTemps(directories)) {
    diagnostics.push(`removed ${swept}, a stale temp file left by an earlier run`);
  }

  // 5-7.
  const uninstall = installStopHandlers(stop, registry);
  let results: FixResult[];
  try {
    const resolver = createResolver(config.policy);
    const context: ExecuteContext = {
      root: config.root,
      resolver,
      allGlobs: resolver.globs(),
      semantics,
      permissions,
      registry,
      stop,
      backupDir,
    };

    results = await mapWithConcurrency(
      plans,
      options.concurrency ?? defaultConcurrency(),
      (plan) => executeFile(context, plan, before.get(plan.path)),
    );
  } finally {
    // Nothing is in flight once the pool has drained, which is the only moment
    // it is safe to unlink temp files that a worker might still have been using.
    registry.cleanup();
    uninstall();
  }

  // Anything the registry still holds is a temp file this run created and could
  // not remove, which usually means the directory stopped being writable
  // underneath it. Saying so is the whole remedy: the file is disposable, but
  // only somebody looking at the tree can delete it now.
  for (const leftover of registry.paths()) {
    diagnostics.push(
      `${leftover} is a temp file this run created and could not remove; it is safe to delete`,
    );
  }

  const count = (status: FixResult['status']): number =>
    results.filter((result) => result.status === status).length;
  const changed = results.filter((result) => result.after !== undefined);
  const interruptSkip = (result: FixResult): boolean =>
    result.status === 'skipped' && result.reason === INTERRUPTED_REASON;

  const report: FixReport = {
    rasterwrightVersion: version,
    runId: randomUUID(),
    engine: engineVersions(),
    dryRun: false,
    permissions,
    configPath: config.configPath,
    root: config.root,
    summary: {
      checked: results.length,
      fixed: count('fixed'),
      unchanged: count('unchanged'),
      unchangedWithWarnings: results.filter(
        (result) => result.status === 'unchanged' && result.plan.warnings.length > 0,
      ).length,
      skipped: count('skipped'),
      blocked: count('blocked'),
      failed: count('failed'),
      bytesBefore: changed.reduce((total, result) => total + result.before.bytes, 0),
      bytesAfter: changed.reduce((total, result) => total + (result.after?.bytes ?? 0), 0),
      interrupted: stop.requested,
      completed: results.filter((result) => !interruptSkip(result)).length,
      ignored: check.summary.ignored,
    },
    conflicts,
    // Unchanged files are counted and omitted, exactly as the plan report omits
    // them: repeating what `check --json` already says would bury the files this
    // run actually touched.
    results: results.filter((result) => result.status !== 'unchanged'),
    unrecovered: recovery.needsAttention,
    diagnostics,
  };

  return { report, diagnostics };
}

/** True when anything about this run is still outstanding. Drives the exit code. */
export function fixNeedsAttention(report: FixReport): boolean {
  return (
    report.summary.interrupted ||
    report.unrecovered.length > 0 ||
    report.results.some((result) => result.needsAttention)
  );
}

/**
 * Refuse, or warn, about what git can and cannot restore.
 *
 * Inside a repository every overwrite is recoverable with `git checkout --`,
 * except on files git has no stored copy of. Those get a warning naming the
 * remedy that actually works for their case, and never a block: the user asked
 * for the fix.
 *
 * Outside a repository, or when git could not answer, there is no undo at all,
 * and the run refuses unless `--no-git` or `--backup-dir` says to proceed
 * anyway. "Unknown" is treated as "no" rather than as "clean" for the reason
 * `operations/git.ts` was written around: a confident wrong answer here sends
 * the whole run down the wrong path.
 */
function gitPreconditions(
  root: string,
  executing: readonly FilePlan[],
  options: RunFixOptions,
  backupDir: string | undefined,
): string[] {
  const permitted = options.noGit === true || backupDir !== undefined;
  const survey = surveyGit(root, executing.map((plan) => plan.path));

  if (survey.state === 'in-repo') {
    const diagnostics: string[] = [];
    for (const plan of executing) {
      const remedy = REMEDIES[classifyPath(survey, plan.path)];
      if (remedy !== undefined) diagnostics.push(`${plan.path} ${remedy}`);
    }
    return diagnostics;
  }

  const cause =
    survey.state === 'not-a-repo'
      ? `${root} is not inside a git repository`
      : `git could not tell whether ${root} is a repository (${survey.reason ?? 'no reason given'})`;

  if (!permitted) {
    throw new RasterwrightError(
      `${cause}, so an overwrite could not be undone`,
      'Rerun with --no-git to accept that, or --backup-dir <path> to copy every original first.',
    );
  }

  return [
    backupDir === undefined
      ? `${cause}; --no-git was given, so these overwrites cannot be undone`
      : `${cause}; every original is copied to ${backupDir} before it is overwritten`,
  ];
}

/** How to make each unrecoverable case recoverable. One remedy per state. */
const REMEDIES: Partial<Record<ReturnType<typeof classifyPath>, string>> = {
  modified: 'has uncommitted changes, which are the one thing git cannot restore; commit or stash them first',
  untracked: 'is not tracked by git, so overwriting it cannot be undone; `git add` it or use --backup-dir',
  ignored: 'is excluded by .gitignore, so git has no copy of it; `git add -f` it or use --backup-dir',
  unknown: 'could not be classified by git, so whether an overwrite can be undone is unknown',
};

/**
 * Every directory this run could write into.
 *
 * Scoped to the plans that would actually write, never the whole tree: the
 * sweep and the recovery pass are the only writes that happen before any file
 * is executed, and they have no business touching a directory this run was
 * never going to open.
 */
function writeDirectories(root: string, executing: readonly FilePlan[]): string[] {
  const directories = new Set<string>();
  for (const plan of executing) {
    directories.add(path.dirname(toAbsolute(root, plan.path)));
    directories.add(path.dirname(toAbsolute(root, plan.targetPath)));
  }
  return [...directories].sort();
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
