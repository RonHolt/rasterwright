import { createResolver } from './config/resolve.js';
import { discover } from './scanner/discover.js';
import { inspect } from './scanner/inspect.js';
import { aggregateFixability, evaluate } from './policy/evaluate.js';
import { defaultConcurrency, mapWithConcurrency } from './utils/concurrency.js';
import type { LoadedConfig } from './config/load.js';
import type { CheckReport, FileResult, Finding } from './types.js';

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
        // A governed image we cannot read is a governed image we are not
        // governing. That is an error, not a silent pass, but it does not stop
        // the batch: every other file is still checked.
        const finding: Finding = {
          path: relativePath,
          rule: '(built-in)',
          check: 'decode',
          severity: 'error',
          actual: null,
          allowed: null,
          fixable: 'no',
          message: result.error,
        };
        return {
          path: relativePath,
          status: 'error',
          matchedGlobs: resolver.resolve(relativePath).matchedGlobs,
          findings: [finding],
          fixable: aggregateFixability([finding]),
          error: result.error,
        };
      }
      return evaluate(result.info, resolver.resolve(relativePath));
    },
  );

  const withErrors = files.filter((file) => file.status === 'error');
  // Counted independently of errors: a file can have both, and reporting it in
  // only the worse bucket made the warning section disagree with the summary.
  const withWarnings = files.filter((file) => file.findings.some((f) => f.severity === 'warning'));
  const findings = files.flatMap((file) => file.findings);
  const count = (severity: string): number =>
    findings.filter((finding) => finding.severity === severity).length;

  const report: CheckReport = {
    rasterwrightVersion: version,
    // Warnings never make a run unclean. Only errors do.
    clean: withErrors.length === 0,
    configPath: config.configPath,
    root: config.root,
    summary: {
      checked: files.length,
      // Files carrying only informational findings still count as clean.
      clean: files.filter((file) => file.status === 'clean' || file.status === 'info').length,
      withWarnings: withWarnings.length,
      withErrors: withErrors.length,
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info'),
      unreadable: files.filter((file) => file.error !== undefined).length,
      ignored,
    },
    files,
  };

  return { report, diagnostics };
}
