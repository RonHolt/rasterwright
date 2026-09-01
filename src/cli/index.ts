#!/usr/bin/env node
import { Command } from 'commander';

import { checkCommand } from './check.js';
import { fixCommand } from './fix.js';
import { readVersion } from './version.js';
import { EXIT_ERROR, RasterwrightError } from '../utils/errors.js';

const program = new Command();

/** Shared by every command that inspects images. */
function parseConcurrency(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RasterwrightError(`--concurrency: expected a positive integer, got ${value}`);
  }
  return parsed;
}

const streams = {
  out: (text: string) => process.stdout.write(`${text}\n`),
  err: (text: string) => process.stderr.write(`${text}\n`),
};

program
  .name('rasterwright')
  .description('Image policy and verification tool for software projects')
  .version(readVersion());

program
  .command('check')
  .description('Report image policy violations. Never modifies anything.')
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
  .description('Plan image fixes. Only --dry-run is implemented; nothing is ever written.')
  .option('-c, --config <path>', 'path to .rasterwright.yml (default: nearest one, searching upwards)')
  .option('--dry-run', 'report what fix would do, and write nothing')
  .option(
    '--allow-renames',
    'permit operations that change a filename (format conversion, extension correction)',
  )
  .option('--json', 'emit machine-readable JSON on stdout instead of a report')
  .option('--no-gitignore', 'do not skip git-ignored files')
  .option('--concurrency <n>', 'number of images to inspect in parallel', parseConcurrency)
  .action(async (options: {
    config?: string;
    dryRun?: boolean;
    allowRenames?: boolean;
    json?: boolean;
    gitignore?: boolean;
    concurrency?: number;
  }) => {
    process.exitCode = await fixCommand({ cwd: process.cwd(), ...options }, streams);
  });

// `review` and `init` are deliberately absent, and so is fix execution. Nothing
// in this build writes an image byte.

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof RasterwrightError) {
      process.stderr.write(`rasterwright: ${error.message}\n`);
      if (error.hint !== undefined) process.stderr.write(`  ${error.hint}\n`);
    } else {
      process.stderr.write(`rasterwright: ${(error as Error).stack ?? String(error)}\n`);
    }
    process.exitCode = EXIT_ERROR;
  }
}

void main();
