import type { FilePlan, PlanSetConflict } from '../types.js';

/**
 * Batch preflight over a whole plan set. Pure.
 *
 * `planFile()` is deliberately file-local: it sees one `FileResult` and nothing
 * else, which is what makes a plan deterministic and testable without images.
 * The cost of that purity is that it cannot see the ways a plan collides with
 * the world around it:
 *
 *   1. two files planning to write the same output path;
 *   2. a rename whose target is already occupied on disk;
 *   3. a rename that would land on a path another plan is vacating;
 *   4. a target that could not be probed at all.
 *
 * None of these is visible from inside one file, and every one of them destroys
 * data if executed. This module is where the plan set meets the repository. It
 * still imports no `node:fs`: the caller hands it the paths that exist, so the
 * same inputs always produce the same answer and the whole thing is testable
 * with string arrays.
 *
 * ## Conservative refusal always wins
 *
 * Every ambiguity resolves to "block it". Rasterwright does not sequence
 * renames, does not pick a winner between two plans claiming one path, and does
 * not reason about whether an occupying file is about to move away. A batch that
 * would need ordering to be safe is a batch it declines to run, and the user is
 * told exactly which paths collided. Losing an image is permanent; a refused
 * plan costs one rerun after a rename.
 *
 * ## Case
 *
 * macOS and Windows treat `Hero.webp` and `hero.webp` as the same file. On those
 * platforms paths are folded before comparison, so two plans that differ only in
 * case still collide. That is deliberately *not* symmetrical with glob matching,
 * which is case-sensitive on macOS and Linux for determinism (README, "Glob case
 * sensitivity follows the platform"): matching the wrong file is a reporting
 * bug, and overwriting the wrong file is data loss.
 */

/** How the target filesystem compares two paths. */
export type PathSemantics = 'case-sensitive' | 'case-insensitive';

export interface PlanSetValidation {
  /** Every input plan, in input order, with blocked ones rewritten. */
  plans: FilePlan[];
  /** True when the whole batch could be executed as planned. */
  executable: boolean;
  conflicts: PlanSetConflict[];
}

/**
 * A target the caller tried to probe and could not, with the reason.
 *
 * Keyed by the plan's target path; the value is a short cause the report can
 * quote, in practice an errno such as `EACCES`.
 */
export type UnprobeableTargets = Iterable<readonly [string, string]>;

/**
 * Which comparison a platform needs.
 *
 * darwin and win32 default to case-insensitive. Both can be configured
 * otherwise per volume, and folding on a case-sensitive volume only ever
 * refuses a batch that would have worked - the safe direction to be wrong in.
 */
export function defaultPathSemantics(platform: NodeJS.Platform = process.platform): PathSemantics {
  return platform === 'darwin' || platform === 'win32' ? 'case-insensitive' : 'case-sensitive';
}

/** Only a `planned` plan claims an output path or can be blocked by one. */
function claims(plan: FilePlan): boolean {
  return plan.status === 'planned';
}

/** Whether this plan changes the file's name. */
function renames(plan: FilePlan): boolean {
  return plan.targetPath !== plan.path;
}

export function validatePlanSet(
  plans: readonly FilePlan[],
  existingPaths: Iterable<string>,
  semantics: PathSemantics,
  unprobeable: UnprobeableTargets = [],
): PlanSetValidation {
  /*
   * `toLowerCase()` is the whole of the folding, deliberately. There is no
   * Unicode NFC/NFD normalization here, because both sides of every comparison
   * come from the same source: the directory listing the caller read. A path
   * that arrived as NFD compares against a target derived from that same NFD
   * string, so the byte sequences already agree. Normalizing would introduce a
   * transformation neither the filesystem nor the config performed, and HFS+
   * and APFS do not agree with each other about which form to store.
   */
  const fold = (value: string): string =>
    semantics === 'case-insensitive' ? value.toLowerCase() : value;

  const claiming = plans.filter(claims);

  // Every path that exists before the run, keyed the way the filesystem
  // compares them, so a conflict can name the real spelling on disk.
  const existing = new Map<string, string>();
  for (const existingPath of existingPaths) {
    if (!existing.has(fold(existingPath))) existing.set(fold(existingPath), existingPath);
  }

  const unreadable = new Map<string, string>();
  for (const [target, cause] of unprobeable) {
    if (!unreadable.has(fold(target))) unreadable.set(fold(target), cause);
  }

  // Every output path claimed by this run, and who claimed it.
  const claimants = new Map<string, FilePlan[]>();
  for (const plan of claiming) {
    const key = fold(plan.targetPath);
    const group = claimants.get(key);
    if (group === undefined) claimants.set(key, [plan]);
    else group.push(plan);
  }

  // Sources this run would vacate, so a target occupied by one can be reported
  // as the chain it is - and refused as one, rather than sequenced.
  const movingSources = new Map<string, FilePlan>();
  for (const plan of claiming) {
    if (renames(plan)) movingSources.set(fold(plan.path), plan);
  }

  const conflicts: PlanSetConflict[] = [];

  // Pass 1: two or more plans claiming one output path. Every plan in the group
  // is blocked - there is no defensible way to pick a winner, and writing one of
  // them would leave the run in a state neither plan described.
  for (const plan of claiming) {
    const group = claimants.get(fold(plan.targetPath));
    if (group === undefined || group.length < 2) continue;

    const others = group.filter((other) => other !== plan);
    // "Case-only" when nothing in the group claims this exact spelling: the
    // collision exists solely because the filesystem folds case.
    const caseOnly = others.every((other) => other.targetPath !== plan.targetPath);

    conflicts.push({
      path: plan.path,
      targetPath: plan.targetPath,
      kind: 'duplicate-target',
      caseOnly,
      with: others.map((other) => other.path),
      message:
        `${list(others.map(claimantPhrase))}, so ${plan.targetPath} is claimed by ` +
        `more than one plan${folding(caseOnly)}`,
    });
  }

  // Pass 2: a rename onto a path that already exists, or onto one that could not
  // be probed. Rasterwright never renames over a file it did not create in this
  // run, and never assumes a path it could not read is free.
  for (const plan of claiming) {
    if (!renames(plan)) continue;

    const key = fold(plan.targetPath);
    // A target that folds to the plan's own source is the file itself under a
    // different spelling, not an obstacle.
    if (key === fold(plan.path)) continue;

    const cause = unreadable.get(key);
    if (cause !== undefined) {
      conflicts.push({
        path: plan.path,
        targetPath: plan.targetPath,
        kind: 'target-unreadable',
        caseOnly: false,
        with: [],
        message:
          `${plan.targetPath} could not be checked (${cause}), so Rasterwright cannot ` +
          'tell whether renaming onto it would destroy something',
      });
      continue;
    }

    const occupant = existing.get(key);
    if (occupant === undefined) continue;

    const mover = movingSources.get(key);
    conflicts.push({
      path: plan.path,
      targetPath: plan.targetPath,
      kind: 'target-exists',
      caseOnly: occupant !== plan.targetPath,
      with: [occupant],
      message: mover === undefined
        ? `${occupant} already exists; renaming onto it would destroy that file` +
          folding(occupant !== plan.targetPath)
        : `${occupant} already exists and is itself being renamed; Rasterwright refuses ` +
          `to order renames rather than risk a half-applied chain` +
          folding(occupant !== plan.targetPath),
    });

    // The occupant is another plan's source, which would move away if the
    // renames were ordered. Rasterwright does not order them: a half-applied
    // chain after an interruption loses a file with no record of where it went.
    // Both ends are blocked, and the mover's conflict is about *its* path -
    // the one being claimed out from under it - not about its own target.
    if (mover !== undefined) {
      const caseOnly = plan.targetPath !== mover.path;
      conflicts.push({
        path: mover.path,
        targetPath: mover.path,
        kind: 'source-claimed',
        caseOnly,
        with: [plan.path],
        message:
          `${plan.path} would be renamed onto ${mover.path}, which this plan moves away; ` +
          `Rasterwright refuses to order renames rather than risk a half-applied chain` +
          folding(caseOnly),
      });
    }
  }

  // Emit conflicts in plan order, then in the order they were found, so the
  // report reads down the file list rather than in discovery order.
  const order = new Map(plans.map((plan, index) => [plan.path, index] as const));
  conflicts.sort((a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0));

  // A plan can legitimately collide in more than one way, but it must never say
  // the same thing twice: a two-cycle (`a.png -> b.webp` while `b.webp -> a.png`)
  // reaches both passes from both ends.
  const seen = new Set<string>();
  const unique = conflicts.filter((item) => {
    const key = `${item.path}\0${item.kind}\0${item.with.join('\0')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const byPath = new Map<string, PlanSetConflict[]>();
  for (const item of unique) {
    const group = byPath.get(item.path);
    if (group === undefined) byPath.set(item.path, [item]);
    else group.push(item);
  }

  return {
    plans: plans.map((plan) => {
      const found = byPath.get(plan.path);
      return found === undefined || !claims(plan) ? plan : block(plan, found);
    }),
    executable: unique.length === 0,
    conflicts: unique,
  };
}

/**
 * How one competing claimant is described.
 *
 * Each claimant is named with its *own* output path, not the path of the plan
 * being blocked: under case folding those spellings differ, and printing the
 * wrong one would send the reader to a file that does not exist.
 */
function claimantPhrase(other: FilePlan): string {
  return other.path === other.targetPath
    ? `${other.path} is rewritten in place by this run`
    : `${other.path} is renamed to ${other.targetPath}`;
}

function folding(caseOnly: boolean): string {
  return caseOnly
    ? ' (the paths differ only in case, and this filesystem treats them as one file)'
    : '';
}

function list(phrases: readonly string[]): string {
  if (phrases.length <= 1) return phrases[0] ?? '';
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}

/**
 * Rewrite a plan as blocked.
 *
 * The plan itself is preserved under `blockedOperations`, exactly as a
 * `requires-permission` file preserves the plan it is waiting on: the user needs
 * to see what Rasterwright wanted to do in order to resolve the collision. What
 * it *would* have resolved moves to `unresolved`, because it resolves nothing,
 * and everything that only happens as a side effect of executing is cleared for
 * the same reason - nothing executes.
 */
function block(plan: FilePlan, conflicts: readonly PlanSetConflict[]): FilePlan {
  return {
    ...plan,
    status: 'blocked',
    operations: [],
    blockedOperations: plan.operations.length > 0 ? plan.operations : plan.blockedOperations,
    resolves: [],
    unresolved: plan.resolves,
    normalizedDuringRewrite: [],
    requiresVerification: false,
    reasons: [...plan.reasons, ...conflicts.map((item) => item.message)],
  };
}
