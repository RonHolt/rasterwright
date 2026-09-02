import { EXIT_ERRORS } from './errors.js';
import type { TempRegistry } from '../operations/atomic.js';

/**
 * Ctrl+C, handled so that no image is ever caught half-written.
 *
 * The rule from 04 section 8 is that an interrupted run leaves every file
 * either wholly as it was or wholly as the plan describes, and never anything
 * in between. That is a property of *where* the run stops, not of how fast it
 * stops, so the first signal does exactly one thing: set a flag.
 *
 * It deliberately does **not** unlink temp files. A worker can be between
 * `open` and `rename` at that moment, and pulling its temp file out from under
 * it turns a safe write into a failed one. Workers check the flag at the top of
 * each file and return `skipped`; the write already in flight is atomic and
 * completes. `registry.cleanup()` runs after the worker pool drains, which is
 * the point at which nothing is in flight by construction.
 *
 * The second signal is the escape hatch for a user who is done waiting. It
 * cleans up and exits immediately, which is the one case where cleanup can race
 * a write in progress - acceptable, because the alternative is a process that
 * cannot be killed.
 */

export interface StopFlag {
  requested: boolean;
  signal: NodeJS.Signals | undefined;
}

export function createStopFlag(): StopFlag {
  return { requested: false, signal: undefined };
}

/**
 * Listen for SIGINT and SIGTERM. Returns a function that removes the listeners.
 *
 * The uninstall matters as much as the install: these handlers hold a reference
 * to one run's registry, and a process that ran two of them would otherwise
 * accumulate handlers pointing at registries nobody is filling any more.
 */
export function installStopHandlers(
  flag: StopFlag,
  registry: TempRegistry,
  write: (text: string) => void = (text) => void process.stderr.write(text),
): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    if (flag.requested) {
      registry.cleanup();
      process.exit(EXIT_ERRORS);
    }
    flag.requested = true;
    flag.signal = signal;
    write('rasterwright: stopping after the files already in flight...\n');
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}
