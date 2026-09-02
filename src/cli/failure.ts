import { EXIT_ERROR, RasterwrightError } from '../utils/errors.js';
import { readVersion } from './version.js';
import type { Streams } from './check.js';

/**
 * How a command reports a failure it cannot recover from.
 *
 * The human message always goes to stderr, hint included. What `--json` adds is
 * a document on stdout, because a caller that asked for JSON gets JSON: a run
 * that printed a parseable report on success and nothing at all on failure
 * forces every consumer to special-case an empty stdout, and the most likely
 * way to handle that badly is to read "no output" as "no findings".
 *
 * The shape is deliberately not a `CheckReport` with zero files. Nothing was
 * checked, and a report saying "0 errors" would be a lie in exactly the
 * situation where being believed matters most.
 */
export function reportFailure(error: unknown, json: boolean, streams: Streams): number {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof RasterwrightError ? error.hint : undefined;

  streams.err(`rasterwright: ${message}`);
  if (hint !== undefined) streams.err(`  ${hint}`);

  if (json) {
    streams.out(
      JSON.stringify(
        { rasterwrightVersion: safeVersion(), error: message, exitCode: EXIT_ERROR },
        null,
        2,
      ),
    );
  }

  return EXIT_ERROR;
}

/** The version, or a placeholder: a broken install must not break the error path. */
function safeVersion(): string {
  try {
    return readVersion();
  } catch {
    return 'unknown';
  }
}
