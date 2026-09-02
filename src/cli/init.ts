import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILENAME, CONFIG_FILENAME_ALT } from '../config/load.js';
import { appendGitignoreEntry, gitignoreStatus, GITIGNORE_ENTRY } from '../init/gitignore.js';
import { renderInitSummary } from './render/init.js';
import { reportFailure } from './failure.js';
import { runInit } from '../run-init.js';
import { EXIT_CLEAN, RasterwrightError } from '../utils/errors.js';
import type { Streams } from './check.js';

export interface InitCommandOptions {
  cwd: string;
  /** Where to write. Default: `.rasterwright.yml` in `cwd`. */
  config?: string;
  /** Write the commented template without scanning. */
  bare?: boolean;
  /** Overwrite an existing config. */
  force?: boolean;
  /** Do not add `.rasterwright/` to `.gitignore`. */
  keepGitignore?: boolean;
  /** Commander's `--no-gitignore`: scan git-ignored images too. */
  gitignore?: boolean;
  concurrency?: number;
}

/**
 * `rasterwright init`.
 *
 * The only writer in the command, and it writes at most two files: the config
 * it was asked for, and one appended block in `.gitignore`. It creates no
 * directories, no `.rasterwright/`, and no cache. The scan that produces the
 * numbers is the same read-only pipeline `check` uses.
 *
 * Exit codes:
 *
 *   0  a config was written
 *   2  nothing was written: the file exists and `--force` was not passed, the
 *      target directory does not exist, or the scan failed
 *
 * There is no exit `1`. `init` is not a gate. A generated config that already
 * flags three files has still succeeded at the thing it was asked to do, and
 * the summary says how many, so the exit code has nothing left to add.
 */
export async function initCommand(options: InitCommandOptions, streams: Streams): Promise<number> {
  try {
    const target = path.resolve(options.cwd, options.config ?? CONFIG_FILENAME);
    const root = path.dirname(target);
    const force = options.force === true;

    requireDirectory(root, target);
    const notes = checkForExistingConfig(target, root, force);

    const result = await runInit(root, {
      ...(options.bare === true ? { bare: true } : {}),
      noGitignore: options.gitignore === false,
      ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    });

    // 'wx' rather than a prior `existsSync`, so the refusal is the filesystem's
    // answer at the moment of the write rather than an answer from a moment ago.
    try {
      fs.writeFileSync(target, result.text, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw alreadyExists(target);
      throw new RasterwrightError(`could not write ${target}: ${(error as Error).message}`);
    }

    const gitignore = updateGitignore(root, options.keepGitignore === true);

    for (const line of renderInitSummary(result, { gitignore, notes })) streams.err(line);
    streams.out(target);

    return EXIT_CLEAN;
  } catch (error) {
    return reportFailure(error, false, streams);
  }
}

function requireDirectory(root: string, target: string): void {
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) return;
  throw new RasterwrightError(
    `cannot write ${target}: ${root} is not an existing directory`,
    'init writes one file and creates no directories. Make the directory first.',
  );
}

function alreadyExists(target: string): RasterwrightError {
  return new RasterwrightError(
    `${target} already exists`,
    'Pass --force to overwrite it, or --config <path> to write somewhere else.',
  );
}

/**
 * Refuse to write a config that would be shadowed, and say which wins otherwise.
 *
 * `findConfig` tries `.rasterwright.yml` first and `.rasterwright.yaml` second,
 * in the same directory, and the order is what decides here.
 *
 *   - writing the `.yaml` beside an existing `.yml`: the new file loses, and a
 *     config no command will ever read is a refusal, not a warning;
 *   - writing the `.yml` beside an existing `.yaml`: the new file wins, which
 *     is what was asked for, but the old one is now dead weight and should be
 *     said out loud;
 *   - writing a name the user chose: they will pass `--config` to reach it
 *     anyway, so the note just says which file the bare commands will load.
 */
function checkForExistingConfig(target: string, root: string, force: boolean): string[] {
  const name = path.basename(target);
  const preferred = path.join(root, CONFIG_FILENAME);
  const alternate = path.join(root, CONFIG_FILENAME_ALT);

  if (name === CONFIG_FILENAME_ALT && fs.existsSync(preferred)) {
    if (!force) {
      throw new RasterwrightError(
        `${preferred} already exists, and Rasterwright loads it in preference to ${target}`,
        'Edit that file instead, write to it with --config, or pass --force to write this one anyway.',
      );
    }
    return [`note: ${preferred} still exists and takes precedence, so nothing will read ${target}`];
  }

  if (name === CONFIG_FILENAME && fs.existsSync(alternate)) {
    return [`note: ${alternate} also exists, but ${target} takes precedence and will be the one loaded`];
  }

  const shadowing = [preferred, alternate].filter(
    (candidate) => path.basename(candidate) !== name && fs.existsSync(candidate),
  );
  if (shadowing.length === 0) return [];

  return [`note: ${shadowing[0]} also exists; commands without --config will load that one`];
}

/** Append the ignore entry, and describe what happened either way. */
function updateGitignore(root: string, keep: boolean): string {
  if (keep) return 'left .gitignore alone (--keep-gitignore)';

  const status = gitignoreStatus(root);
  if (status === 'not-a-repo') return `not a git work tree, so .gitignore was left alone`;
  if (status === 'already-ignored') return `${GITIGNORE_ENTRY} is already ignored; .gitignore unchanged`;

  try {
    appendGitignoreEntry(root);
    return `added ${GITIGNORE_ENTRY} to .gitignore`;
  } catch (error) {
    // The config is already on disk. Failing the run now would report "nothing
    // was written" about a run that wrote the file the user asked for.
    return `could not update .gitignore: ${(error as Error).message}`;
  }
}
