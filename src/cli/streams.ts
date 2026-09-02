import { EXIT_ERROR } from '../utils/errors.js';
import type { Streams } from './check.js';

/**
 * The CLI's stdout and stderr, with a closed reader treated as a normal ending.
 *
 * `rasterwright check --json | head -60` closes the read end of the pipe as soon
 * as it has what it wants. The next write fails with `EPIPE`, and because
 * `process.stdout` is a stream, that arrives as an unhandled `'error'` event -
 * which crashes Node and prints a stack trace over the user's terminal for
 * something that is not a fault at all. Piping into `head`, quitting `less`, or
 * closing a terminal mid-run is ordinary use.
 *
 * So both streams get an `'error'` handler, and an `EPIPE` on one stops further
 * writing to it and nothing else: the exit code stays whatever the command
 * computed, and nothing is printed about it. There is nowhere to print it to.
 *
 * Any other stream error is a real failure and still surfaces - reported on
 * stderr when it was stdout that broke, and forcing exit code 2 either way,
 * because output the caller was promised did not arrive.
 *
 * Only the process's own two streams are covered here. Errors from file writes
 * elsewhere are unrelated and must keep propagating.
 */
export function createStreams(): Streams {
  let stdoutBroken = false;
  let stderrBroken = false;

  const writeErr = (text: string): void => {
    if (stderrBroken) return;
    process.stderr.write(text);
  };

  // A write that fails reports it on a later tick, so a write already in flight
  // can raise a second error after the first has set the flag. Handling both
  // the same way is what keeps that from being a crash.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    stdoutBroken = true;
    if (error.code === 'EPIPE') return;
    process.exitCode = EXIT_ERROR;
    writeErr(`rasterwright: cannot write to stdout: ${error.message}\n`);
  });

  process.stderr.on('error', (error: NodeJS.ErrnoException) => {
    stderrBroken = true;
    if (error.code === 'EPIPE') return;
    // Nowhere left to say it. The exit code is the whole report.
    process.exitCode = EXIT_ERROR;
  });

  return {
    out: (text: string) => {
      if (stdoutBroken) return;
      process.stdout.write(`${text}\n`);
    },
    err: (text: string) => writeErr(`${text}\n`),
  };
}
