import { createResolver } from './config/resolve.js';
import { discover } from './scanner/discover.js';
import { inspect } from './scanner/inspect.js';
import { evaluate } from './policy/evaluate.js';
import { defaultConcurrency, mapWithConcurrency } from './utils/concurrency.js';
import type { LoadedConfig } from './config/load.js';
import type { CheckReport, FileResult } from './types.js';

/**
 * The `check` pipeline:
 *
 *   config -> discovery -> inspection -> policy resolution -> evaluation
 *
 * Strictly read-only. Nothing on this path opens a file for writing, creates a
 * directory, or writes a cache. The CLI calls this and renders the result; it
 * never touches Sharp itself.
 */

export interface RunCheckOptions {
  /** Skip the `.gitignore` filter during discovery. */
  noGitignore?: boolean;
  /** Bounded parallelism for image inspection. */
  concurrency?: number;
}

export interface RunCheckResult {
  report: CheckReport;
  /** Non-fatal facts about the run, for stderr / JSON consumers. */
  diagnostics: string[];
}

export async function runCheck(
  config: LoadedConfig,
  version: string,
  options: RunCheckOptions = {},
): Promise<RunCheckResult> {
  const diagnostics: string[] = [];
  const resolver = createResolver(config.policy);

  const discovery = discover(config.root, { noGitignore: options.noGitignore ?? false });
  if (!discovery.gitignoreApplied && discovery.gitignoreSkippedReason !== 'nothing to filter') {
    diagnostics.push(`.gitignore not applied: ${discovery.gitignoreSkippedReason}`);
  }

  // Resolve rules before inspecting. A file matched by no rule is ungoverned
  // and is skipped silently, which also means we never pay to decode it.
  const governed: string[] = [];
  let ignored = 0;
  for (const file of discovery.files) {
    if (resolver.isGoverned(file)) governed.push(file);
    else ignored += 1;
  }

  const files = await mapWithConcurrency(
    governed,
    options.concurrency ?? defaultConcurrency(),
    async (relativePath): Promise<FileResult> => {
      const result = await inspect(config.root, relativePath);
      if (!result.ok) {
        return {
          path: relativePath,
          status: 'error',
          matchedGlobs: resolver.resolve(relativePath).matchedGlobs,
          violations: [],
          notes: [],
          fixable: 'no',
          error: result.error,
        };
      }
      return evaluate(result.info, resolver.resolve(relativePath));
    },
  );

  const violating = files.filter((file) => file.status === 'violating');
  const errors = files.filter((file) => file.status === 'error');
  const violations = violating.reduce((total, file) => total + file.violations.length, 0);

  const report: CheckReport = {
    rasterwrightVersion: version,
    // An image we could not read is not a clean result. It is a file that is
    // supposed to be governed and is not being governed.
    clean: violating.length === 0 && errors.length === 0,
    configPath: config.configPath,
    root: config.root,
    summary: {
      checked: files.length,
      compliant: files.filter((file) => file.status === 'compliant').length,
      violating: violating.length,
      violations,
      errors: errors.length,
      ignored,
    },
    files,
  };

  return { report, diagnostics };
}
