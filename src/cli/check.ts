import { loadConfig } from '../config/load.js';
import { runCheck } from '../run-check.js';
import { renderHuman } from './render/human.js';
import { renderJson } from './render/json.js';
import { EXIT_CLEAN, EXIT_VIOLATIONS } from '../utils/errors.js';
import { readVersion } from './version.js';

export interface CheckCommandOptions {
  cwd: string;
  config?: string;
  json?: boolean;
  gitignore?: boolean;
  concurrency?: number;
}

export interface Streams {
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * `rasterwright check`.
 *
 * Read-only, always. Returns the process exit code rather than calling
 * `process.exit`, so it stays testable.
 *
 * With `--json`, stdout carries JSON and nothing else; diagnostics go to stderr.
 */
export async function checkCommand(options: CheckCommandOptions, streams: Streams): Promise<number> {
  const config = loadConfig(options.cwd, options.config);
  const version = readVersion();

  const { report, diagnostics } = await runCheck(config, version, {
    noGitignore: options.gitignore === false,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });

  if (options.json === true) {
    for (const diagnostic of diagnostics) streams.err(`rasterwright: ${diagnostic}`);
    streams.out(renderJson(report, diagnostics));
  } else {
    for (const diagnostic of diagnostics) streams.err(`rasterwright: ${diagnostic}`);
    streams.out(renderHuman(report));
  }

  return report.clean ? EXIT_CLEAN : EXIT_VIOLATIONS;
}
