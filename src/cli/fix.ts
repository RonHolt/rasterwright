import { loadConfig } from '../config/load.js';
import { runFixPlan } from '../run-fix.js';
import { renderPlanHuman, renderPlanJson } from './render/plan.js';
import { EXIT_CLEAN, EXIT_ERROR, EXIT_ERRORS } from '../utils/errors.js';
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
}

/**
 * `rasterwright fix`.
 *
 * Only `--dry-run` does anything in this build, and it writes nothing at all -
 * it runs `check`'s read-only pipeline and reports the plan that would follow.
 *
 * Plain `fix` deliberately fails rather than quietly behaving as a dry run.
 * Silently making the dangerous command safe teaches the habit of typing the
 * dangerous command, which is exactly the muscle memory not to build before an
 * executor exists.
 *
 * Exit codes match `check`'s meanings:
 *
 *   0  every error is covered by a plan this run could execute (or none exist)
 *   1  at least one file is left unresolved - blocked, unfixable, unsupported
 *   2  configuration or runtime failure
 *
 * So `fix --dry-run` exiting 0 means "Rasterwright has a complete plan". As in
 * `check`, warnings never affect it.
 */
export async function fixCommand(options: FixCommandOptions, streams: Streams): Promise<number> {
  if (options.dryRun !== true) {
    streams.err('rasterwright: fix execution is not implemented yet.');
    streams.err('  Use `rasterwright fix --dry-run` to inspect the planned changes.');
    return EXIT_ERROR;
  }

  const config = loadConfig(options.cwd, options.config);
  const version = readVersion();

  const { report, diagnostics } = await runFixPlan(config, version, {
    noGitignore: options.gitignore === false,
    allowRenames: options.allowRenames === true,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });

  for (const diagnostic of diagnostics) streams.err(`rasterwright: ${diagnostic}`);
  streams.out(options.json === true ? renderPlanJson(report, diagnostics) : renderPlanHuman(report));

  return report.complete ? EXIT_CLEAN : EXIT_ERRORS;
}
