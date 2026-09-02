import { createResolver } from '../config/resolve.js';
import { BUILT_IN_DEFAULTS, SUPPORTED_EXTENSIONS } from '../config/schema.js';
import { evaluate } from '../policy/evaluate.js';
import { parseBytes } from '../utils/bytes.js';
import type { ImageInfo, Policy } from '../types.js';

/**
 * The `init` heuristic, as pure functions over plain data.
 *
 * Nothing here opens a file, calls Sharp or reads the clock. It takes the paths
 * and the `ImageInfo` a scan already produced and returns the rules a config
 * should contain, which is what makes the whole heuristic testable from a
 * handful of literals.
 *
 * The shape of the answer is deliberately small: at most three rules, each with
 * a `maxWidth` and a `maxBytes` taken from a fixed ladder of round numbers. A
 * generated config is a starting point a human edits, and a starting point with
 * eleven rules and a `maxWidth` of 1437 is one nobody edits, they just delete.
 */

/** The extension group a generated glob ends with when only lowercase was seen. */
export const EXTENSION_GROUP = `*.{${SUPPORTED_EXTENSIONS.join(',')}}`;

/**
 * Characters picomatch reads as pattern syntax rather than as themselves.
 *
 * A directory really can be called `img (old)` or `[drafts]`, and interpolating
 * one straight into a glob produces a rule that governs nothing while looking
 * like it governs everything. Escaping is unconditional rather than clever:
 * `!` is only special leading, and `+`/`@` only before a parenthesis, but a
 * backslash in front of any of them is always the literal character.
 */
const GLOB_SPECIAL = /[\\*?[\]{}()!+@|,]/g;

/** Quote a literal path segment so picomatch matches it as itself. */
export function escapeGlobLiteral(literal: string): string {
  return literal.replace(GLOB_SPECIAL, (character) => `\\${character}`);
}

/**
 * The `*.{...}` group, carrying every extension spelling the scan actually saw.
 *
 * Discovery matches extensions case-insensitively, so `hero.JPG` is found, but
 * rule matching is case-sensitive everywhere except Windows. A group of four
 * lowercase spellings would therefore discover that file, match nothing, and
 * report it as ungoverned - in a config generated from a scan that measured it.
 *
 * Only spellings present in the corpus are added, so the common case stays the
 * short, readable group, and `SCREAM.PNG` earns its place by existing.
 */
export function extensionGroupFor(paths: readonly string[]): string {
  const canonical = new Set<string>(SUPPORTED_EXTENSIONS);
  const extra = new Set<string>();

  for (const file of paths) {
    const dot = file.lastIndexOf('.');
    if (dot === -1) continue;
    const extension = file.slice(dot + 1);
    if (canonical.has(extension)) continue;
    if (canonical.has(extension.toLowerCase())) extra.add(extension);
  }

  return `*.{${[...SUPPORTED_EXTENSIONS, ...[...extra].sort()].join(',')}}`;
}

/** More rules than this and the config stops being readable at a glance. */
export const MAX_RULES = 3;

/** An anchor holding fewer images than this is not evidence of anything. */
export const MIN_GROUP = 3;

/** How many rungs the closure loop may climb before it gives up. */
export const MAX_CLOSURE_STEPS = 8;

/**
 * Width rungs, in pixels.
 *
 * Round numbers a human would have typed. The point of rounding up to one is
 * that the generated limit reads as a decision rather than as a measurement of
 * whatever happened to be in the repository on the day `init` ran.
 */
export const WIDTH_LADDER: readonly number[] = [640, 800, 1000, 1200, 1600, 2000, 2400, 3000, 4000];

export interface ByteRung {
  /** How the rung is written in the config, e.g. `300kb`. */
  label: string;
  /** What `parseBytes` makes of that label. */
  bytes: number;
}

/**
 * Byte rungs.
 *
 * Declared as the labels a config would contain and converted through the real
 * parser, so a rung can never mean something other than what it says. All
 * 1024-based, like every other byte value in Rasterwright.
 */
export const BYTE_LADDER: readonly ByteRung[] = [
  '50kb',
  '100kb',
  '150kb',
  '200kb',
  '300kb',
  '500kb',
  '750kb',
  '1mb',
  '1.5mb',
  '2mb',
  '3mb',
  '5mb',
].map((label) => ({ label, bytes: parseBytes(label, `init byte ladder ${label}`) }));

/** A directory the generated rules are anchored on. `''` is the project root. */
export interface Anchor {
  dir: string;
  /**
   * Whether the glob reaches into subdirectories.
   *
   * The root anchor is non-recursive on purpose: one stray `screenshot.png`
   * beside `package.json` must not produce a rule that governs the whole tree.
   */
  recursive: boolean;
  /** Repo-relative POSIX paths this anchor covers, sorted. */
  files: string[];
}

export interface ProposedRule {
  glob: string;
  maxWidth: number;
  maxBytes: ByteRung;
  /** Every discovered image the glob matches, sorted. */
  files: string[];
  stats: RuleStats;
}

export interface RuleStats {
  /** Images with usable measurements, which is what the numbers came from. */
  measured: number;
  widestSeen: number;
  p90Width: number;
  largestSeen: number;
  p95Bytes: number;
}

/** POSIX dirname. The root directory is the empty string, not `.`. */
export function dirnameOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf('/');
  return cut === -1 ? '' : relativePath.slice(0, cut);
}

/** How deep a directory sits. The project root is zero. */
function depthOf(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length;
}

/**
 * The glob for an anchor. `group` is required rather than defaulted, because
 * `anchors.map(globFor)` would otherwise hand the array index to it silently.
 */
export function globFor(anchor: Pick<Anchor, 'dir' | 'recursive'>, group: string): string {
  if (anchor.dir === '') return anchor.recursive ? `**/${group}` : group;
  // Only the directory is escaped. The `**` and the extension group are pattern
  // syntax we wrote ourselves and mean exactly what they say.
  return `${escapeGlobLiteral(anchor.dir)}/**/${group}`;
}

/**
 * Nearest-rank percentile.
 *
 * Sort ascending and take the element at `ceil(p/100 * n)`, one-based. No
 * interpolation: every value returned is a width or a byte count that actually
 * exists in the repository, which makes the provenance comment in the generated
 * config literally true.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) throw new Error('percentile of an empty set');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index]!;
}

/** Index of the first rung at or above `value`; the top rung when nothing is. */
export function rungIndex(ladder: readonly number[], value: number): number {
  const found = ladder.findIndex((rung) => rung >= value);
  return found === -1 ? ladder.length - 1 : found;
}

/** The first rung at or above `value`, or the top rung when `value` exceeds it. */
export function roundUp(ladder: readonly number[], value: number): number {
  return ladder[rungIndex(ladder, value)]!;
}

/** Same, over the byte ladder. */
export function roundUpBytes(value: number): ByteRung {
  const index = rungIndex(
    BYTE_LADDER.map((rung) => rung.bytes),
    value,
  );
  return BYTE_LADDER[index]!;
}

/**
 * Choose the directories the rules will be anchored on.
 *
 *   1. group by directory
 *   2. let a recursive anchor absorb everything beneath it
 *   3. drop anchors holding fewer than three images, unless that leaves none
 *   4. while more than three remain, roll the deepest one up to its parent
 *   5. a roll-up that reaches the project root collapses to one broad rule
 *
 * Deterministic: ties in step 4 are broken by taking the lexicographically last
 * directory, so the same corpus always produces the same globs.
 */
export function anchorsFor(paths: readonly string[]): Anchor[] {
  if (paths.length === 0) return [];

  const byDir = new Map<string, string[]>();
  for (const file of paths) {
    const dir = dirnameOf(file);
    const bucket = byDir.get(dir);
    if (bucket === undefined) byDir.set(dir, [file]);
    else bucket.push(file);
  }

  let anchors: Anchor[] = [...byDir].map(([dir, files]) => ({
    dir,
    recursive: dir !== '',
    files: [...files].sort(),
  }));

  anchors = absorb(anchors);
  anchors = dropSmall(anchors);

  // Each roll-up strictly reduces the depth of one anchor, so this terminates;
  // the guard is there so a future edit to the loop body cannot hang a CLI.
  for (let guard = 0; anchors.length > MAX_RULES; guard += 1) {
    if (guard > 1000) return [broadAnchor(paths)];

    const deepest = pickDeepest(anchors);
    const parent = dirnameOf(deepest.dir);
    if (deepest.dir === '' || parent === '') return [broadAnchor(paths)];

    deepest.dir = parent;
    deepest.recursive = true;
    anchors = absorb(anchors);
  }

  return sortAnchors(anchors);
}

function broadAnchor(paths: readonly string[]): Anchor {
  return { dir: '', recursive: true, files: [...paths].sort() };
}

/** Merge every anchor that sits at or beneath a recursive anchor into it. */
function absorb(anchors: Anchor[]): Anchor[] {
  const kept: Anchor[] = [];

  for (const anchor of [...anchors].sort((a, b) => depthOf(a.dir) - depthOf(b.dir))) {
    const host = kept.find((candidate) => covers(candidate, anchor));
    if (host === undefined) {
      kept.push(anchor);
      continue;
    }
    host.files = [...new Set([...host.files, ...anchor.files])].sort();
  }

  return kept;
}

/** Would `host`'s glob match everything `other` holds? */
function covers(host: Anchor, other: Anchor): boolean {
  if (host === other) return false;
  if (host.dir === other.dir) return host.recursive || !other.recursive;
  if (!host.recursive) return false;
  if (host.dir === '') return true;
  return other.dir.startsWith(`${host.dir}/`);
}

function dropSmall(anchors: Anchor[]): Anchor[] {
  const survivors = anchors.filter((anchor) => anchor.files.length >= MIN_GROUP);
  return survivors.length > 0 ? survivors : anchors;
}

function pickDeepest(anchors: Anchor[]): Anchor {
  return anchors.reduce((best, candidate) => {
    const deeper = depthOf(candidate.dir) - depthOf(best.dir);
    if (deeper > 0) return candidate;
    if (deeper < 0) return best;
    return candidate.dir >= best.dir ? candidate : best;
  });
}

function sortAnchors(anchors: Anchor[]): Anchor[] {
  return [...anchors].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/**
 * Turn anchors into rules with numbers on them.
 *
 * `maxWidth` is the 90th percentile of displayed widths and `maxBytes` the 95th
 * percentile of file sizes, each rounded up its ladder. Bytes get the looser
 * percentile because an image corpus is usually bimodal - a pile of small icons
 * and a handful of photographs - and p90 on bytes lands between the two humps,
 * which produces a config that flags every photograph on the day it is written.
 */
export function proposeRules(
  anchors: readonly Anchor[],
  infos: ReadonlyMap<string, ImageInfo>,
  group = EXTENSION_GROUP,
): ProposedRule[] {
  const rules: ProposedRule[] = [];

  for (const anchor of anchors) {
    const measured = anchor.files.map((file) => infos.get(file)).filter((info): info is ImageInfo => info !== undefined);
    // Every file under this anchor failed to decode. There is nothing to base a
    // number on, and inventing one would be worse than leaving the group out.
    if (measured.length === 0) continue;

    const widths = measured.map((info) => info.width);
    const sizes = measured.map((info) => info.bytes);
    const p90Width = percentile(widths, 90);
    const p95Bytes = percentile(sizes, 95);

    rules.push({
      glob: globFor(anchor, group),
      maxWidth: roundUp(WIDTH_LADDER, p90Width),
      maxBytes: roundUpBytes(p95Bytes),
      files: anchor.files,
      stats: {
        measured: measured.length,
        widestSeen: Math.max(...widths),
        p90Width,
        largestSeen: Math.max(...sizes),
        p95Bytes,
      },
    });
  }

  return rules;
}

/** The in-memory policy a set of proposed rules describes. */
export function policyFor(rules: readonly ProposedRule[]): Policy {
  return {
    version: 1,
    defaults: { ...BUILT_IN_DEFAULTS },
    rules: rules.map((rule) => ({
      glob: rule.glob,
      body: { maxWidth: rule.maxWidth, maxBytes: rule.maxBytes.bytes },
    })),
  };
}

export interface RuleVerdict {
  /** Images the rule governs and that could be measured. */
  governed: number;
  /** Of those, how many exceed `maxWidth`, `maxHeight` or `maxBytes`. */
  overLimit: number;
  widthOver: number;
  bytesOver: number;
}

export interface Verification {
  perRule: Map<string, RuleVerdict>;
  /** Error-level findings, counted the way `check --json` counts them. */
  errors: number;
  warnings: number;
  /** Governed images with at least one error. */
  filesWithErrors: number;
  /** Discovered images no rule matches. */
  ungoverned: string[];
}

/** Checks whose findings the closure loop is allowed to react to. */
const SIZE_CHECKS = new Set(['maxWidth', 'maxHeight', 'maxBytes']);

/**
 * Run the real evaluator over a candidate policy.
 *
 * Deliberately not a second implementation of the rules: the numbers `init`
 * prints are produced by the same `evaluate` that `check` runs, so the count in
 * the summary is exact rather than an estimate that can drift.
 *
 * `unreadableGoverned` is added to the error count because `check` reports one
 * decode error per governed image it cannot read, and a summary that quietly
 * omitted those would disagree with the very next command the user runs.
 */
export function verify(
  rules: readonly ProposedRule[],
  infos: readonly ImageInfo[],
  options: { unreadable?: readonly string[] } = {},
): Verification {
  const resolver = createResolver(policyFor(rules));
  const perRule = new Map<string, RuleVerdict>(
    rules.map((rule) => [rule.glob, { governed: 0, overLimit: 0, widthOver: 0, bytesOver: 0 }]),
  );

  const ungoverned: string[] = [];
  let errors = 0;
  let warnings = 0;
  let filesWithErrors = 0;

  for (const info of infos) {
    const resolved = resolver.resolve(info.path);
    if (resolved.matchedGlobs.length === 0) {
      ungoverned.push(info.path);
      continue;
    }

    const result = evaluate(info, resolved, resolver.globs());
    const findings = result.findings;
    errors += findings.filter((finding) => finding.severity === 'error').length;
    warnings += findings.filter((finding) => finding.severity === 'warning').length;
    if (findings.some((finding) => finding.severity === 'error')) filesWithErrors += 1;

    const sized = findings.filter((finding) => finding.severity === 'error' && SIZE_CHECKS.has(finding.check));
    const overWidth = sized.some((finding) => finding.check !== 'maxBytes');
    const overBytes = sized.some((finding) => finding.check === 'maxBytes');

    for (const glob of resolved.matchedGlobs) {
      const verdict = perRule.get(glob);
      if (verdict === undefined) continue;
      verdict.governed += 1;
      if (sized.length > 0) verdict.overLimit += 1;
      if (overWidth) verdict.widthOver += 1;
      if (overBytes) verdict.bytesOver += 1;
    }
  }

  for (const path of options.unreadable ?? []) {
    if (!resolver.isGoverned(path)) {
      ungoverned.push(path);
      continue;
    }
    errors += 1;
    filesWithErrors += 1;
  }

  ungoverned.sort();
  return { perRule, errors, warnings, filesWithErrors, ungoverned };
}

/** How many files a rule is allowed to flag before its limits are loosened. */
export function toleranceFor(governed: number): number {
  return Math.max(MIN_GROUP, Math.ceil(governed * 0.05));
}

export interface ClosureResult {
  rules: ProposedRule[];
  steps: number;
}

/**
 * Loosen the limits until the generated config is a starting point, not a bill.
 *
 * A config that reports two hundred violations the moment it is written is a
 * config the user deletes, so each rule climbs its ladder until at most
 * `max(3, 5%)` of the images it governs are over a limit. Only dimension and
 * byte findings drive this: an extension that disagrees with its contents, or a
 * stray EXIF block, is a real finding that no ceiling can move, and reacting to
 * one would loosen the policy for a reason that has nothing to do with size.
 *
 * Bounded twice over - eight steps, and both ladders topping out - so a corpus
 * that cannot be satisfied produces a config with honest numbers and a summary
 * that says how many files it flags, rather than a loop.
 */
export function closeRules(rules: readonly ProposedRule[], infos: readonly ImageInfo[]): ClosureResult {
  let current = rules.map((rule) => ({ ...rule }));

  for (let step = 1; step <= MAX_CLOSURE_STEPS; step += 1) {
    const verification = verify(current, infos);
    let bumped = false;

    for (const rule of current) {
      const verdict = verification.perRule.get(rule.glob);
      if (verdict === undefined) continue;
      if (verdict.overLimit <= toleranceFor(verdict.governed)) continue;
      if (bumpRule(rule, verdict)) bumped = true;
    }

    if (!bumped) return { rules: current, steps: step - 1 };
  }

  return { rules: current, steps: MAX_CLOSURE_STEPS };
}

/**
 * Raise one limit by one rung. Returns false when both ladders have topped out.
 *
 * In practice this nearly always moves `maxWidth`. A nearest-rank p95 leaves at
 * most 5% of a group above it, and the tolerance is 5%, so a freshly proposed
 * byte limit starts inside tolerance and the byte branch is reached only when
 * the width ladder has topped out on an unusually large corpus. That is by
 * design rather than by accident: the byte percentile is the looser of the two
 * precisely so that bytes are not what a generated config argues with.
 */
function bumpRule(rule: ProposedRule, verdict: RuleVerdict): boolean {
  // Width first on a tie: it is the limit a human reads as the headline of a
  // rule, and a width bump usually takes byte violations with it, since the
  // files that are too wide are generally the files that are too big.
  const order = verdict.widthOver >= verdict.bytesOver ? ['width', 'bytes'] : ['bytes', 'width'];

  for (const which of order) {
    if (which === 'width') {
      const next = WIDTH_LADDER.indexOf(rule.maxWidth) + 1;
      if (next > 0 && next < WIDTH_LADDER.length) {
        rule.maxWidth = WIDTH_LADDER[next]!;
        return true;
      }
    } else {
      const next = BYTE_LADDER.findIndex((rung) => rung.bytes === rule.maxBytes.bytes) + 1;
      if (next > 0 && next < BYTE_LADDER.length) {
        rule.maxBytes = BYTE_LADDER[next]!;
        return true;
      }
    }
  }

  return false;
}
