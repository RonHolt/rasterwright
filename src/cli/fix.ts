import { loadConfig } from '../config/load.js';
import { fixNeedsAttention, runFix, runFixPlan } from '../run-fix.js';
import { reportFailure } from './failure.js';
import { renderFixHuman, renderFixJson } from './render/fix.js';
import { renderPlanHuman, renderPlanJson } from './render/plan.js';
import { EXIT_CLEAN, EXIT_ERRORS } from '../utils/errors.js';
import { readVersion } from './version.js';
import type { Streams } from './check.js';

export interface FixCommandOptions {
  cwd: string;
  config?: string;
  dryRun?: boolean;
  allowRenames?: boolean;
  json?: boolean;
  gitignore?: boolean;
  concurrency?: number;
  noGit?: boolean;
  backupDir?: string;
}

/**
 * `rasterwright fix`.
 *
 * Two paths that share one preflight and nothing else. `--dry-run` runs
 * `check`'s read-only pipeline, plans over the result and prints; it opens
 * nothing for writing, with or without `--allow-renames`. The real path plans
 * exactly the same way and then executes what it planned.
 *
 * Exit codes:
 *
 *   0  nothing is left needing attention, and the run was not interrupted
 *   1  a file failed, was skipped or was blocked, or the run was interrupted
 *   2  configuration failure, a refused precondition, or an unexpected error
 *
 * Exit 1 rather than 130 on an interrupt, so the whole tool speaks in three
 * codes and a caller never has to special-case a signal number.
 */
export async function fixCommand(options: FixCommandOptions, streams: Streams): Promise<number> {
  try {
    return await runFixCommand(options, streams);
  } catch (error) {
    // Caught here rather than in `index.ts` so `--json` still produces a single
    // parseable document. See `reportFailure`.
    return reportFailure(error, options.json === true, streams);
  }
}

async function runFixCommand(options: FixCommandOptions, streams: Streams): Promise<number> {
  const config = loadConfig(options.cwd, options.config);
  const version = readVersion();

  const shared = {
    noGitignore: options.gitignore === false,
    allowRenames: options.allowRenames === true,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  };

  if (options.dryRun === true) {
    const { report, diagnostics } = await runFixPlan(config, version, shared);
    for (const diagnostic of diagnostics) streams.err(`rasterwright: ${diagnostic}`);
    streams.out(options.json === true ? renderPlanJson(report, diagnostics) : renderPlanHuman(report));
    return report.complete ? EXIT_CLEAN : EXIT_ERRORS;
  }

  const { report, diagnostics } = await runFix(config, version, {
    ...shared,
    noGit: options.noGit === true,
    ...(options.backupDir === undefined ? {} : { backupDir: options.backupDir }),
  });

  // Diagnostics go to stderr in both modes, so `--json` leaves stdout parseable
  // and a human run still sees the git warnings next to the report.
  for (const diagnostic of diagnostics) streams.err(`rasterwright: ${diagnostic}`);
  streams.out(options.json === true ? renderFixJson(report, diagnostics) : renderFixHuman(report));

  return fixNeedsAttention(report) ? EXIT_ERRORS : EXIT_CLEAN;
}
