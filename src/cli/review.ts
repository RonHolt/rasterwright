import { loadConfig } from '../config/load.js';
import { openInBrowser } from '../review/open.js';
import { renderReview, NOTHING_RECORDED } from './render/review.js';
import { reportFailure } from './failure.js';
import { runReview } from '../run-review.js';
import { EXIT_CLEAN } from '../utils/errors.js';
import type { Streams } from './check.js';

export interface ReviewCommandOptions {
  cwd: string;
  config?: string;
  /** `--keep <n>`: how many runs to retain from now on. Persisted in the manifest. */
  keep?: number;
  /** `--clean`: delete the review directory. */
  clean?: boolean;
  /** `--no-open`: print the path instead of opening a browser. */
  open?: boolean;
}

/**
 * `rasterwright review`.
 *
 * Exit codes:
 *
 *   0  the page was rendered, or there was nothing to render
 *   2  configuration or runtime failure
 *
 * There is no exit `1`. `review` is not a gate: it reports what a previous run
 * did, and that run has already had its say about the exit code. A project where
 * `fix` has never been run is not a project with a problem, so "nothing to
 * review" is a message on stderr and a clean exit, not a failure.
 */
export async function reviewCommand(options: ReviewCommandOptions, streams: Streams): Promise<number> {
  try {
    const config = loadConfig(options.cwd, options.config);
    const result = await runReview(config, {
      ...(options.keep === undefined ? {} : { keep: options.keep }),
      ...(options.clean === true ? { clean: true } : {}),
    });

    for (const diagnostic of result.diagnostics) streams.err(`rasterwright: ${diagnostic}`);

    if (result.cleaned) {
      streams.out(renderReview(result, false));
      return EXIT_CLEAN;
    }
    if (result.indexPath === undefined) {
      streams.err(
        options.clean === true
          ? 'rasterwright: there was no review directory to remove'
          : `rasterwright: ${NOTHING_RECORDED}`,
      );
      return EXIT_CLEAN;
    }

    // CI has no browser and no user in front of it, and a detached opener there
    // is a process nobody will ever close.
    const wanted = options.open !== false && (process.env.CI ?? '') === '';
    let opened = false;
    if (wanted) {
      const failure = openInBrowser(result.indexPath);
      if (failure === undefined) opened = true;
      else streams.err(`rasterwright: ${failure}; open the path below by hand`);
    }

    streams.out(renderReview(result, opened));
    return EXIT_CLEAN;
  } catch (error) {
    return reportFailure(error, false, streams);
  }
}
