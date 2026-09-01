import { describe, expect, it } from 'vitest';

import {
  defaultPathSemantics,
  validatePlanSet,
  type PathSemantics,
} from '../../src/operations/plan-set.js';
import type { FilePlan, PlannedOperation } from '../../src/types.js';

/**
 * Batch preflight is the only part of planning that can see across files, and
 * it is the part that decides whether a batch is allowed to destroy something.
 * Every test here is a string comparison: the module takes plans and paths and
 * returns conflicts, so none of this needs an image or a filesystem.
 */

function renameOp(from: string, to: string): PlannedOperation {
  return { op: 'rename', from, to, reason: 'format-conversion', reencode: true };
}

/** A `planned` plan by default, because only those claim a path. */
function plan(overrides: Partial<FilePlan> & { path: string }): FilePlan {
  const targetPath = overrides.targetPath ?? overrides.path;
  return {
    targetPath,
    status: 'planned',
    operations: targetPath === overrides.path ? [] : [renameOp(overrides.path, targetPath)],
    blockedOperations: [],
    resolves: ['format'],
    unresolved: [],
    normalizedDuringRewrite: [],
    warnings: [],
    requiresVerification: false,
    requiredPermissions: [],
    reasons: [],
    notes: [],
    ...overrides,
  };
}

function statuses(plans: readonly FilePlan[]): string[] {
  return plans.map((item) => item.status);
}

function sensitive(plans: readonly FilePlan[], existing: string[] = []) {
  return validatePlanSet(plans, existing, 'case-sensitive');
}

function insensitive(plans: readonly FilePlan[], existing: string[] = []) {
  return validatePlanSet(plans, existing, 'case-insensitive');
}

describe('defaultPathSemantics', () => {
  it('folds case on the platforms whose filesystems do', () => {
    expect(defaultPathSemantics('darwin')).toBe('case-insensitive');
    expect(defaultPathSemantics('win32')).toBe('case-insensitive');
  });

  it('compares exactly everywhere else', () => {
    for (const platform of ['linux', 'freebsd', 'openbsd', 'sunos', 'aix'] as const) {
      expect(defaultPathSemantics(platform)).toBe('case-sensitive');
    }
  });

  it('defaults to the running platform', () => {
    const expected: PathSemantics =
      process.platform === 'darwin' || process.platform === 'win32'
        ? 'case-insensitive'
        : 'case-sensitive';
    expect(defaultPathSemantics()).toBe(expected);
  });
});

describe('duplicate targets', () => {
  const plans = [
    plan({ path: 'a/hero.jpg', targetPath: 'a/hero.webp' }),
    plan({ path: 'a/hero.png', targetPath: 'a/hero.webp' }),
  ];

  it('blocks every plan claiming the path, not an arbitrary loser', () => {
    // There is no defensible way to pick a winner, and writing one of them
    // leaves the run in a state neither plan described.
    const result = sensitive(plans);

    expect(statuses(result.plans)).toEqual(['blocked', 'blocked']);
    expect(result.executable).toBe(false);
    expect(result.conflicts).toHaveLength(2);
    expect(result.conflicts.every((conflict) => conflict.kind === 'duplicate-target')).toBe(true);
  });

  it('names the other claimant in the conflict and in the reason', () => {
    const [first, second] = sensitive(plans).plans as [FilePlan, FilePlan];

    expect(first.reasons.join(' ')).toContain('a/hero.png');
    expect(first.reasons.join(' ')).toContain('a/hero.webp');
    expect(second.reasons.join(' ')).toContain('a/hero.jpg');
  });

  it('blocks all three when three plans converge', () => {
    const result = sensitive([
      plan({ path: 'a/x.jpg', targetPath: 'a/x.webp' }),
      plan({ path: 'a/x.png', targetPath: 'a/x.webp' }),
      plan({ path: 'a/x.jpeg', targetPath: 'a/x.webp' }),
    ]);

    expect(statuses(result.plans)).toEqual(['blocked', 'blocked', 'blocked']);
    expect(result.conflicts[0]?.with).toEqual(['a/x.png', 'a/x.jpeg']);
  });

  it('treats a rename onto a path another plan rewrites in place as a duplicate', () => {
    // `logo.webp` is being re-encoded where it stands while `logo.png` is being
    // renamed on top of it. Both plans are individually correct.
    const result = sensitive([
      plan({ path: 'a/logo.png', targetPath: 'a/logo.webp' }),
      plan({ path: 'a/logo.webp' }),
    ]);

    expect(statuses(result.plans)).toEqual(['blocked', 'blocked']);
    expect(result.conflicts.map((conflict) => conflict.kind)).toEqual([
      'duplicate-target',
      'duplicate-target',
    ]);
  });

  it('leaves distinct targets alone', () => {
    const result = sensitive([
      plan({ path: 'a/one.jpg', targetPath: 'a/one.webp' }),
      plan({ path: 'a/two.jpg', targetPath: 'a/two.webp' }),
    ]);

    expect(statuses(result.plans)).toEqual(['planned', 'planned']);
    expect(result.executable).toBe(true);
  });
});

describe('occupied rename targets', () => {
  it('blocks a rename onto a file that already exists', () => {
    const result = sensitive([plan({ path: 'a/logo.png', targetPath: 'a/logo.webp' })], [
      'a/logo.png',
      'a/logo.webp',
    ]);

    expect(statuses(result.plans)).toEqual(['blocked']);
    expect(result.conflicts[0]).toMatchObject({
      path: 'a/logo.png',
      targetPath: 'a/logo.webp',
      kind: 'target-exists',
      caseOnly: false,
      with: ['a/logo.webp'],
    });
  });

  it('blocks a rename onto a directory or any other occupant', () => {
    // The occupant need not be an image, or even a file. Anything holding the
    // name is enough.
    const result = sensitive([plan({ path: 'a/icon.jpg', targetPath: 'a/icon.webp' })], [
      'a/icon.webp',
    ]);
    expect(statuses(result.plans)).toEqual(['blocked']);
  });

  it('does not block an in-place plan by the file it is rewriting', () => {
    // Every planned in-place rewrite targets a path that exists. That is the
    // normal case, not a collision.
    const result = sensitive([plan({ path: 'a/heavy.jpg' })], ['a/heavy.jpg']);

    expect(statuses(result.plans)).toEqual(['planned']);
    expect(result.executable).toBe(true);
  });

  it('does not treat the plan its own source as an obstacle', () => {
    // On a case-insensitive filesystem `a/Logo.PNG` and `a/logo.png` are the
    // same file, so a rename between them is not landing on anything.
    const result = insensitive([plan({ path: 'a/Logo.PNG', targetPath: 'a/logo.png' })], [
      'a/Logo.PNG',
    ]);

    expect(statuses(result.plans)).toEqual(['planned']);
    expect(result.conflicts).toEqual([]);
  });

  it('leaves a rename to a free path alone', () => {
    const result = sensitive([plan({ path: 'a/hero.jpg', targetPath: 'a/hero.webp' })], [
      'a/hero.jpg',
      'a/other.webp',
    ]);

    expect(statuses(result.plans)).toEqual(['planned']);
    expect(result.executable).toBe(true);
  });
});

describe('rename chains', () => {
  // hero.png -> hero.webp while hero.webp -> hero.jpg. Ordering the two renames
  // would work, and Rasterwright refuses to: a half-applied chain after an
  // interruption loses a file with no record of where it went.
  const plans = [
    plan({ path: 'a/hero.png', targetPath: 'a/hero.webp' }),
    plan({ path: 'a/hero.webp', targetPath: 'a/hero.jpg' }),
  ];
  const existing = ['a/hero.png', 'a/hero.webp'];

  it('blocks both ends rather than sequencing them', () => {
    const result = sensitive(plans, existing);
    expect(statuses(result.plans)).toEqual(['blocked', 'blocked']);
  });

  it('says why, on the plan that would otherwise look free', () => {
    const result = sensitive(plans, existing);
    const [, second] = result.plans as [FilePlan, FilePlan];

    expect(second.reasons.join(' ')).toContain('a/hero.png');
    expect(second.reasons.join(' ')).toMatch(/refuses to order renames/);
  });

  it('gives the mover its own kind, about the path being claimed from under it', () => {
    // The mover's own target is free. What is contested is its current path,
    // so that is what the conflict names.
    const claimed = sensitive(plans, existing).conflicts.find(
      (conflict) => conflict.kind === 'source-claimed',
    );

    expect(claimed).toMatchObject({
      path: 'a/hero.webp',
      targetPath: 'a/hero.webp',
      caseOnly: false,
      with: ['a/hero.png'],
    });
  });

  it('computes caseOnly for the claimed path, not for the occupant lookup', () => {
    // The incoming rename targets `a/Hero.webp`; the mover sits at
    // `a/hero.webp`. Those differ only in case, and that is the pair the
    // mover's conflict is about.
    const result = insensitive(
      [
        plan({ path: 'a/hero.png', targetPath: 'a/Hero.webp' }),
        plan({ path: 'a/hero.webp', targetPath: 'a/hero.jpg' }),
      ],
      ['a/hero.png', 'a/hero.webp'],
    );
    const claimed = result.conflicts.find((conflict) => conflict.kind === 'source-claimed');

    expect(claimed).toMatchObject({ path: 'a/hero.webp', caseOnly: true });
    expect(claimed?.message).toMatch(/differ only in case/);
  });

  it('says each thing once when two renames swap places', () => {
    // A two-cycle reaches both passes from both ends. Each plan collides in two
    // genuinely different ways, and must not say either of them twice.
    const result = sensitive(
      [
        plan({ path: 'a/one.png', targetPath: 'a/two.webp' }),
        plan({ path: 'a/two.webp', targetPath: 'a/one.png' }),
      ],
      ['a/one.png', 'a/two.webp'],
    );

    expect(statuses(result.plans)).toEqual(['blocked', 'blocked']);
    expect(result.conflicts).toHaveLength(4);
    for (const item of result.plans) {
      expect(new Set(item.reasons).size).toBe(item.reasons.length);
    }
  });

  it('blocks every link of a longer chain', () => {
    const result = sensitive(
      [
        plan({ path: 'a/x.png', targetPath: 'a/x.webp' }),
        plan({ path: 'a/x.webp', targetPath: 'a/x.jpg' }),
        plan({ path: 'a/x.jpg', targetPath: 'a/x.jpeg' }),
      ],
      ['a/x.png', 'a/x.webp', 'a/x.jpg'],
    );

    expect(statuses(result.plans)).toEqual(['blocked', 'blocked', 'blocked']);
  });
});

describe('case sensitivity', () => {
  const converging = [
    plan({ path: 'a/hero.jpg', targetPath: 'a/Hero.webp' }),
    plan({ path: 'a/hero.png', targetPath: 'a/hero.webp' }),
  ];

  it('ignores a case-only duplicate where the filesystem does', () => {
    const result = sensitive(converging);
    expect(statuses(result.plans)).toEqual(['planned', 'planned']);
  });

  it('blocks a case-only duplicate where the filesystem folds', () => {
    const result = insensitive(converging);

    expect(statuses(result.plans)).toEqual(['blocked', 'blocked']);
    expect(result.conflicts.every((conflict) => conflict.caseOnly)).toBe(true);
    expect(result.conflicts[0]?.message).toMatch(/differ only in case/);
  });

  it('ignores a case-only occupant where the filesystem does', () => {
    const result = sensitive([plan({ path: 'a/logo.png', targetPath: 'a/logo.webp' })], [
      'a/LOGO.WEBP',
    ]);
    expect(statuses(result.plans)).toEqual(['planned']);
  });

  it('blocks a case-only occupant where the filesystem folds', () => {
    const result = insensitive([plan({ path: 'a/logo.png', targetPath: 'a/logo.webp' })], [
      'a/LOGO.WEBP',
    ]);

    expect(statuses(result.plans)).toEqual(['blocked']);
    expect(result.conflicts[0]).toMatchObject({
      kind: 'target-exists',
      caseOnly: true,
      // The real spelling on disk, not the spelling the plan asked for.
      with: ['a/LOGO.WEBP'],
    });
  });

  it('reports an exact duplicate as exact even when a case-only one is also present', () => {
    const result = insensitive([
      plan({ path: 'a/one.jpg', targetPath: 'a/hero.webp' }),
      plan({ path: 'a/two.jpg', targetPath: 'a/hero.webp' }),
      plan({ path: 'a/three.jpg', targetPath: 'a/Hero.webp' }),
    ]);

    expect(result.conflicts.map((conflict) => conflict.caseOnly)).toEqual([false, false, true]);
  });
});

describe('unprobeable targets', () => {
  const plans = [plan({ path: 'a/logo.png', targetPath: 'a/logo.webp' })];

  it('blocks a target whose existence could not be determined', () => {
    const result = validatePlanSet(plans, [], 'case-sensitive', [['a/logo.webp', 'EACCES']]);

    expect(statuses(result.plans)).toEqual(['blocked']);
    expect(result.conflicts[0]).toMatchObject({
      path: 'a/logo.png',
      targetPath: 'a/logo.webp',
      kind: 'target-unreadable',
      with: [],
    });
  });

  it('names the cause, so the message is actionable', () => {
    const result = validatePlanSet(plans, [], 'case-sensitive', [
      ['a/logo.webp', 'ENAMETOOLONG'],
    ]);
    expect(result.conflicts[0]?.message).toMatch(/could not be checked \(ENAMETOOLONG\)/);
  });

  it('folds the target path like every other comparison', () => {
    const result = validatePlanSet(plans, [], 'case-insensitive', [['a/LOGO.WEBP', 'ELOOP']]);
    expect(statuses(result.plans)).toEqual(['blocked']);
  });

  it('does not block an in-place plan, which probes nothing', () => {
    const result = validatePlanSet([plan({ path: 'a/logo.webp' })], [], 'case-sensitive', [
      ['a/logo.webp', 'EACCES'],
    ]);
    expect(statuses(result.plans)).toEqual(['planned']);
  });
});

describe('how a conflict names the other plans', () => {
  it('prints each claimant with its own target path, not this plan\'s', () => {
    // Under folding the two targets are the same file with different spellings.
    // Printing this plan's spelling would send the reader to a path that does
    // not exist.
    const result = insensitive([
      plan({ path: 'a/one.jpg', targetPath: 'a/hero.webp' }),
      plan({ path: 'a/two.jpg', targetPath: 'a/Hero.webp' }),
    ]);

    expect(result.conflicts[0]?.message).toContain('a/two.jpg is renamed to a/Hero.webp');
    expect(result.conflicts[1]?.message).toContain('a/one.jpg is renamed to a/hero.webp');
  });

  it('says an in-place rewrite is a rewrite, not another rename', () => {
    const result = sensitive([
      plan({ path: 'a/logo.png', targetPath: 'a/logo.webp' }),
      plan({ path: 'a/logo.webp' }),
    ]);

    expect(result.conflicts[0]?.message).toContain('a/logo.webp is rewritten in place by this run');
    expect(result.conflicts[0]?.message).not.toContain('renamed to');
  });

  it('lists every other claimant when more than two converge', () => {
    const result = sensitive([
      plan({ path: 'a/x.jpg', targetPath: 'a/x.webp' }),
      plan({ path: 'a/x.png', targetPath: 'a/x.webp' }),
      plan({ path: 'a/x.jpeg', targetPath: 'a/x.webp' }),
    ]);

    expect(result.conflicts[0]?.message).toContain(
      'a/x.png is renamed to a/x.webp and a/x.jpeg is renamed to a/x.webp',
    );
    expect(result.conflicts[0]?.message).toContain('claimed by more than one plan');
  });
});

describe('statuses other than planned', () => {
  const others: FilePlan['status'][] = [
    'unchanged',
    'requires-permission',
    'unfixable',
    'unsupported',
  ];

  it('never blocks a plan that was not going to run', () => {
    const plans = others.map((status) =>
      plan({ path: `a/${status}.jpg`, targetPath: 'a/hero.webp', status }),
    );
    const result = sensitive(plans, ['a/hero.webp']);

    expect(statuses(result.plans)).toEqual(others);
    expect(result.conflicts).toEqual([]);
    expect(result.executable).toBe(true);
  });

  it('never lets one claim a path away from a plan that would run', () => {
    // A `requires-permission` file has a target path but is not going to write
    // to it, so it cannot collide with anything.
    const result = sensitive([
      plan({ path: 'a/hero.jpg', targetPath: 'a/hero.webp' }),
      plan({ path: 'a/hero.png', targetPath: 'a/hero.webp', status: 'requires-permission' }),
    ]);

    expect(statuses(result.plans)).toEqual(['planned', 'requires-permission']);
    expect(result.executable).toBe(true);
  });

  it('does not let a non-running plan occupy a chain link', () => {
    const result = sensitive(
      [
        plan({ path: 'a/hero.png', targetPath: 'a/hero.webp' }),
        plan({ path: 'a/hero.webp', targetPath: 'a/hero.jpg', status: 'unfixable' }),
      ],
      ['a/hero.png', 'a/hero.webp'],
    );

    // The first is still blocked: the occupant exists and is not moving.
    expect(statuses(result.plans)).toEqual(['blocked', 'unfixable']);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.message).not.toMatch(/order renames/);
  });
});

describe('the shape of a blocked plan', () => {
  const result = sensitive(
    [
      plan({
        path: 'a/logo.png',
        targetPath: 'a/logo.webp',
        requiresVerification: true,
        normalizedDuringRewrite: ['metadata'],
      }),
    ],
    ['a/logo.webp'],
  );
  const blocked = result.plans[0] as FilePlan;

  it('executes nothing and keeps the plan it refused', () => {
    expect(blocked.operations).toEqual([]);
    expect(blocked.blockedOperations).toEqual([renameOp('a/logo.png', 'a/logo.webp')]);
  });

  it('resolves nothing, and says what stays unresolved', () => {
    expect(blocked.resolves).toEqual([]);
    expect(blocked.unresolved).toEqual(['format']);
  });

  it('leaves permissions alone: this is not a permission problem', () => {
    expect(blocked.requiredPermissions).toEqual([]);
  });

  it('keeps the target path, so the report can name what collided', () => {
    expect(blocked.targetPath).toBe('a/logo.webp');
  });

  it('claims nothing that only happens while executing', () => {
    // Nothing runs, so there is no encode to verify and no metadata swept up
    // along the way. `requires-permission` clears both for the same reason.
    expect(blocked.requiresVerification).toBe(false);
    expect(blocked.normalizedDuringRewrite).toEqual([]);
  });
});

describe('purity', () => {
  const plans = [
    plan({ path: 'a/hero.jpg', targetPath: 'a/hero.webp' }),
    plan({ path: 'a/hero.png', targetPath: 'a/hero.webp' }),
    plan({ path: 'a/logo.png', targetPath: 'a/logo.webp' }),
    plan({ path: 'a/fine.jpg' }),
  ];
  const existing = ['a/hero.jpg', 'a/hero.png', 'a/logo.png', 'a/logo.webp', 'a/fine.jpg'];

  it('does not mutate the plans it was given', () => {
    const before = structuredClone(plans);
    sensitive(plans, existing);
    expect(plans).toEqual(before);
  });

  it('returns the plans in input order', () => {
    const result = sensitive(plans, existing);
    expect(result.plans.map((item) => item.path)).toEqual(plans.map((item) => item.path));
  });

  it('is deterministic', () => {
    expect(sensitive(plans, existing)).toEqual(sensitive(plans, existing));
  });

  it('orders conflicts by plan, not by discovery', () => {
    const result = sensitive(plans, existing);
    expect(result.conflicts.map((conflict) => conflict.path)).toEqual([
      'a/hero.jpg',
      'a/hero.png',
      'a/logo.png',
    ]);
  });

  it('ties executable to the absence of conflicts, both ways', () => {
    expect(sensitive(plans, existing).executable).toBe(false);
    expect(sensitive(plans, existing).conflicts.length).toBeGreaterThan(0);

    const clean = sensitive([plan({ path: 'a/fine.jpg' })], ['a/fine.jpg']);
    expect(clean.executable).toBe(true);
    expect(clean.conflicts).toEqual([]);
  });

  it('accepts any iterable of existing paths', () => {
    const result = validatePlanSet(
      [plan({ path: 'a/logo.png', targetPath: 'a/logo.webp' })],
      // A Set is what a caller deduplicating a scan actually has.
      new Set(['a/logo.webp']),
      'case-sensitive',
    );
    expect(statuses(result.plans)).toEqual(['blocked']);
  });

  it('handles an empty plan set', () => {
    expect(sensitive([], ['a/anything.png'])).toEqual({ plans: [], executable: true, conflicts: [] });
  });
});
