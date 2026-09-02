#!/usr/bin/env node
import { Command } from 'commander';

import { checkCommand } from './check.js';
import { fixCommand } from './fix.js';
import { initCommand } from './init.js';
import { reviewCommand } from './review.js';
import { createStreams } from './streams.js';
import { readVersion } from './version.js';
import { EXIT_CLEAN, EXIT_ERROR, RasterwrightError } from '../utils/errors.js';

const program = new Command();

/**
 * Shared by every command that inspects images.
 *
 * Matched as a whole rather than handed to `parseInt`, which reads `1.5` as 1
 * and `4bananas` as 4. Silently rounding a value the user typed on purpose is
 * how a flag comes to mean something other than what it says.
 */
function positiveInteger(flag: string, value: string): number {
  if (!/^[0-9]+$/.test(value.trim())) {
    throw new RasterwrightError(`${flag}: expected a positive integer, got ${value}`);
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RasterwrightError(`${flag}: expected a positive integer, got ${value}`);
  }
  return parsed;
}

function parseConcurrency(value: string): number {
  return positiveInteger('--concurrency', value);
}

function parseKeep(value: string): number {
  return positiveInteger('--keep', value);
}

// Installed before anything writes, so a reader that closes early - `| head`, a
// quit from `less` - never turns into a stack trace. See `createStreams`.
const streams = createStreams();

program
  .name('rasterwright')
  .description('Image policy and verification tool for software projects')
  .version(readVersion());

program
  .command('init')
  .description('Write a starter .rasterwright.yml, with limits measured from the images already here.')
  .allowExcessArguments(false)
  .option('-c, --config <path>', 'where to write the config (default: .rasterwright.yml here)')
  .option('--bare', 'write the commented template without scanning anything')
  .option('-f, --force', 'overwrite an existing config')
  .option('--keep-gitignore', 'do not add .rasterwright/ to .gitignore')
  .option('--no-gitignore', 'do not skip git-ignored files while scanning')
  .option('--concurrency <n>', 'number of images to inspect in parallel', parseConcurrency)
  .action(async (options: {
    config?: string;
    bare?: boolean;
    force?: boolean;
    keepGitignore?: boolean;
    gitignore?: boolean;
    concurrency?: number;
  }) => {
    process.exitCode = await initCommand({ cwd: process.cwd(), ...options }, streams);
  });

program
  .command('check')
  .description('Report image policy violations. Never modifies anything.')
  // A positional argument is always a mistake here: neither command takes one,
  // and commander's default is to accept and ignore it. `rasterwright check
  // assets/` would then silently check the whole project instead of saying that
  // it cannot narrow the scope that way.
  .allowExcessArguments(false)
  .option('-c, --config <path>', 'path to .rasterwright.yml (default: nearest one, searching upwards)')
  .option('--json', 'emit machine-readable JSON on stdout instead of a report')
  .option('-v, --verbose', 'list every warning and note individually instead of summarizing')
  .option('--no-gitignore', 'do not skip git-ignored files')
  .option('--concurrency <n>', 'number of images to inspect in parallel', parseConcurrency)
  .action(async (options: {
    config?: string;
    json?: boolean;
    verbose?: boolean;
    gitignore?: boolean;
    concurrency?: number;
  }) => {
    process.exitCode = await checkCommand({ cwd: process.cwd(), ...options }, streams);
  });

program
  .command('fix')
  .description('Apply image fixes. Use --dry-run first: it prints the plan and writes nothing.')
  .allowExcessArguments(false)
  .option('-c, --config <path>', 'path to .rasterwright.yml (default: nearest one, searching upwards)')
  .option('--dry-run', 'report what fix would do, and write nothing')
  .option(
    '--allow-renames',
    'permit operations that change a filename (format conversion, extension correction)',
  )
  .option('--json', 'emit machine-readable JSON on stdout instead of a report')
  .option('--no-gitignore', 'do not skip git-ignored files')
  .option('--no-git', 'run outside a git repository, accepting that overwrites cannot be undone')
  .option('--backup-dir <path>', 'copy every original into this directory before overwriting it')
  .option('--no-review', 'do not keep before-copies or record this run for `rasterwright review`')
  .option('--concurrency <n>', 'number of images to process in parallel', parseConcurrency)
  .action(async (options: {
    config?: string;
    dryRun?: boolean;
    allowRenames?: boolean;
    json?: boolean;
    gitignore?: boolean;
    git?: boolean;
    review?: boolean;
    backupDir?: string;
    concurrency?: number;
  }) => {
    // Commander turns `--no-git` into `git: false`, so the flag is read here
    // and passed on under the name the rest of the code uses for it.
    process.exitCode = await fixCommand(
      {
        cwd: process.cwd(),
        ...options,
        noGit: options.git === false,
        noReview: options.review === false,
      },
      streams,
    );
  });

program
  .command('review')
  .description('Open a local before/after page for what the last fix run changed.')
  .allowExcessArguments(false)
  .option('-c, --config <path>', 'path to .rasterwright.yml (default: nearest one, searching upwards)')
  .option('--keep <n>', 'retain this many runs from now on, and prune to it', parseKeep)
  .option('--clean', 'delete .rasterwright/review/ and its retained originals')
  .option('--no-open', 'print the path to the page instead of opening a browser')
  .action(async (options: { config?: string; keep?: number; clean?: boolean; open?: boolean }) => {
    process.exitCode = await reviewCommand({ cwd: process.cwd(), ...options }, streams);
  });

// `check` and `fix --dry-run` still write nothing at all; only plain `fix`
// writes, and only after its preconditions have passed. `review` writes its own
// page and nothing else in the project, and `init` writes the config it was
// asked for plus, in a git repository, one appended block in `.gitignore`.

/**
 * Commander's own failures exit through Rasterwright's codes, not its default.
 *
 * Without this, an unknown flag or a stray positional argument exits 1 - the
 * code that means "the run found problems" - and a script gating on it cannot
 * tell a typo in the command line from a repository full of oversized images.
 * A usage error is a 2: nothing was checked.
 */
program.exitOverride();
for (const command of program.commands) command.exitOverride();

/** Commander throws these for `--help` and `--version`, which are successes. */
const COMMANDER_SUCCESS = new Set(['commander.help', 'commander.helpDisplayed', 'commander.version']);

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== undefined && code.startsWith('commander.')) {
      // Commander has already written its own message, help text included.
      process.exitCode = COMMANDER_SUCCESS.has(code) ? EXIT_CLEAN : EXIT_ERROR;
      return;
    }
    if (error instanceof RasterwrightError) {
      streams.err(`rasterwright: ${error.message}`);
      if (error.hint !== undefined) streams.err(`  ${error.hint}`);
    } else {
      streams.err(`rasterwright: ${(error as Error).stack ?? String(error)}`);
    }
    process.exitCode = EXIT_ERROR;
  }
}

void main();
