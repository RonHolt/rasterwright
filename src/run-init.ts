import { parseConfigText } from './config/load.js';
import { anchorsFor, closeRules, extensionGroupFor, proposeRules, verify } from './init/heuristics.js';
import { scanForInit } from './init/scan.js';
import { renderBare, renderScanned } from './init/template.js';
import type { ProposedRule, Verification } from './init/heuristics.js';
import type { ScanResult } from './init/scan.js';
import type { ImageInfo, Policy } from './types.js';

/**
 * The `init` pipeline:
 *
 *   discovery -> inspection -> grouping -> ladders -> closure -> text
 *
 * Strictly read-only, exactly like `run-check`. It returns the text a config
 * should contain and never puts it anywhere; `cli/init.ts` is the only thing
 * in the command that opens a file for writing. That split is what lets the
 * whole heuristic be tested against real image corpora without a test ever
 * risking a write, and it is why the read-only integration test can assert that
 * a scan of a project changes nothing in it.
 */

export interface RunInitOptions {
  /** Write the commented template without scanning anything. */
  bare?: boolean;
  /** Include git-ignored images in the scan. */
  noGitignore?: boolean;
  concurrency?: number;
}

/** Why a bare template was produced instead of a scanned one. */
export type BareReason = 'flag' | 'no-images';

export interface RunInitResult {
  /** The exact bytes to write. Already validated through the real loader. */
  text: string;
  /** What the loader made of that text. */
  policy: Policy;
  /** The generated rules, in file order. Empty for a bare template. */
  rules: ProposedRule[];
  /** How the generated policy judges the corpus it came from. */
  verification: Verification | undefined;
  scan: ScanResult | undefined;
  bare: BareReason | undefined;
}

export async function runInit(root: string, options: RunInitOptions = {}): Promise<RunInitResult> {
  if (options.bare === true) return bareResult('flag', undefined);

  const scan = await scanForInit(root, {
    noGitignore: options.noGitignore ?? false,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
  });

  // Nothing measurable means nothing to generalize from. A template with a
  // plausible glob in it is more useful than rules invented out of an empty set.
  if (scan.infos.length === 0) return bareResult('no-images', scan);

  const infoByPath = new Map<string, ImageInfo>(scan.infos.map((info) => [info.path, info]));
  // The extension group comes from the whole scan, not per anchor, so every
  // generated rule ends the same way and the file stays readable.
  const group = extensionGroupFor(scan.discovered);
  const proposed = proposeRules(anchorsFor(scan.discovered), infoByPath, group);
  if (proposed.length === 0) return bareResult('no-images', scan);

  const { rules } = closeRules(proposed, scan.infos);
  const verification = verify(rules, scan.infos, { unreadable: scan.unreadable.map((entry) => entry.path) });

  const text = renderScanned(rules, {
    scanned: scan.discovered.length,
    ungoverned: verification.ungoverned.length,
  });

  return { text, policy: parseConfigText(text, '<generated config>'), rules, verification, scan, bare: undefined };
}

function bareResult(bare: BareReason, scan: ScanResult | undefined): RunInitResult {
  const text = renderBare();
  return {
    text,
    policy: parseConfigText(text, '<generated config>'),
    rules: [],
    verification: undefined,
    scan,
    bare,
  };
}
