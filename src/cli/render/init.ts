import type { RunInitResult } from '../../run-init.js';

/**
 * What `init` says about the file it just wrote.
 *
 * The summary is on stderr and the path is on stdout, matching every other
 * command: the artifact goes to stdout, the story about it goes to stderr.
 *
 * The one line worth defending is the violation count. It costs nothing - the
 * files have already been inspected and the real evaluator has already run over
 * the candidate policy - and without it the user's next command tells them, with
 * no warning, that the config `init` just generated is not a clean slate. A
 * generated policy that flags three files is fine; being surprised by it is not.
 */

export interface InitSummaryContext {
  /** What happened to `.gitignore`, as a sentence. */
  gitignore: string;
  /** Anything else worth saying, unprefixed. */
  notes: string[];
}

export function renderInitSummary(result: RunInitResult, context: InitSummaryContext): string[] {
  const lines: string[] = [];
  const say = (text: string): void => void lines.push(`rasterwright: ${text}`);

  if (result.bare === 'flag') {
    say('wrote a bare template; --bare scans nothing, so edit the rule before running `check`');
  } else if (result.bare === 'no-images') {
    say('found no images to measure, so wrote the bare template instead');
    say('edit the rule to point at the directory your images will live in');
  } else {
    say(scanLine(result));
    say(`wrote ${plural(result.rules.length, 'rule')}:`);
    for (const rule of result.rules) {
      const verdict = result.verification?.perRule.get(rule.glob);
      lines.push(`    ${rule.glob}`);
      lines.push(
        `      ${plural(verdict?.governed ?? rule.stats.measured, 'image')}, ` +
          `maxWidth ${rule.maxWidth}, maxBytes ${rule.maxBytes.label}, ` +
          `${verdict?.overLimit ?? 0} over those limits today`,
      );
    }

    const ungoverned = result.verification?.ungoverned.length ?? 0;
    if (ungoverned > 0) {
      say(`${plural(ungoverned, 'image')} matched no rule and ${ungoverned === 1 ? 'is' : 'are'} not governed`);
    }

    const errors = result.verification?.errors ?? 0;
    const warnings = result.verification?.warnings ?? 0;
    say(`\`check\` would report ${plural(errors, 'error')} and ${plural(warnings, 'warning')} against this config`);
  }

  for (const note of context.notes) say(note);
  say(context.gitignore);
  say('next: run `rasterwright check`');

  return lines;
}

function scanLine(result: RunInitResult): string {
  const scan = result.scan;
  if (scan === undefined) return 'scanned nothing';

  const asides: string[] = [];
  if (scan.gitIgnored > 0) asides.push(`${scan.gitIgnored} skipped by .gitignore`);
  if (scan.unreadable.length > 0) asides.push(`${plural(scan.unreadable.length, 'image')} would not decode`);
  if (!scan.gitignoreApplied && scan.gitignoreSkippedReason !== 'nothing to filter') {
    asides.push(`.gitignore not applied: ${scan.gitignoreSkippedReason}`);
  }

  const suffix = asides.length === 0 ? '' : ` (${asides.join('; ')})`;
  return `scanned ${plural(scan.discovered.length, 'image')}${suffix}`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
