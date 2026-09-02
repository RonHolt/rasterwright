import type {
  EncodeOperation,
  FilePlan,
  FixReport,
  FixResult,
  FixSummary,
  ReviewEntry,
  ReviewRun,
} from '../../src/types.js';

/**
 * Synthetic runs and reports for the review unit tests.
 *
 * The manifest, the classifier and the page renderer are all pure functions over
 * plain data, so testing them against hand-built entries is both faster and more
 * precise than fixing a project and reading back what happened: a threshold is
 * proved by an entry that sits exactly on it, which no real image obliges with.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

export function encodeOperation(overrides: Partial<EncodeOperation> = {}): EncodeOperation {
  return {
    op: 'encode',
    format: 'jpeg',
    budgetDriven: false,
    stripMetadata: true,
    preserveAlpha: false,
    lossyReencode: true,
    outcomeRequiresVerification: false,
    preservesOrientation: false,
    ...overrides,
  };
}

export function plan(overrides: Partial<FilePlan> = {}): FilePlan {
  return {
    path: 'assets/hero.jpg',
    targetPath: 'assets/hero.jpg',
    status: 'planned',
    operations: [encodeOperation()],
    blockedOperations: [],
    resolves: [],
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

/** One entry, complete enough to render, with everything overridable. */
export function entry(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    path: 'assets/hero.jpg',
    outputPath: 'assets/hero.jpg',
    status: 'fixed',
    beforeFile: `before/${HASH_A}.jpg`,
    before: { bytes: 400_000, width: 2000, height: 1200, format: 'jpeg' },
    after: { bytes: 200_000, width: 2000, height: 1200, format: 'jpeg', contentHash: HASH_B },
    savingsPct: 50,
    applied: ['encode'],
    operations: [encodeOperation()],
    warnings: [],
    requiredPermissions: [],
    ...overrides,
  };
}

export function summary(overrides: Partial<FixSummary> = {}): FixSummary {
  return {
    checked: 4,
    fixed: 1,
    unchanged: 1,
    unchangedWithWarnings: 0,
    skipped: 1,
    blocked: 0,
    failed: 1,
    bytesBefore: 400_000,
    bytesAfter: 200_000,
    interrupted: false,
    completed: 4,
    ignored: 0,
    ...overrides,
  };
}

export function fakeRun(runId: string, entries: ReviewEntry[] = [entry()]): ReviewRun {
  return {
    runId,
    finishedAt: '2026-09-01T12:00:00.000Z',
    rasterwrightVersion: '0.1.0',
    engine: { sharp: '0.35.4', vips: '8.16.0' },
    permissions: { allowRenames: true },
    interrupted: false,
    summary: summary(),
    entries,
  };
}

function result(overrides: Partial<FixResult> = {}): FixResult {
  return {
    path: 'assets/hero.jpg',
    outputPath: 'assets/hero.jpg',
    status: 'fixed',
    plan: plan(),
    applied: ['encode'],
    before: { bytes: 400_000, width: 2000, height: 1200, format: 'jpeg' },
    warnings: [],
    needsAttention: false,
    ...overrides,
  };
}

/** A report with one written file, one skip and one failure. */
export function fakeReport(): FixReport {
  return {
    rasterwrightVersion: '0.1.0',
    runId: 'run-1',
    engine: { sharp: '0.35.4', vips: '8.16.0' },
    dryRun: false,
    permissions: { allowRenames: true },
    configPath: '/project/.rasterwright.yml',
    root: '/project',
    summary: summary(),
    conflicts: [],
    results: [
      result({
        beforeFile: `before/${HASH_A}.jpg`,
        after: { bytes: 200_000, width: 2000, height: 1200, format: 'jpeg', contentHash: HASH_B },
        savingsPct: 50,
      }),
      result({
        path: 'assets/icon.png',
        outputPath: 'assets/icon.png',
        status: 'skipped',
        applied: [],
        plan: plan({ path: 'assets/icon.png', targetPath: 'assets/icon.png', status: 'unfixable' }),
        before: { bytes: 9_000, width: 64, height: 64, format: 'png' },
        reason: 'transparency present, and JPEG cannot represent it',
        needsAttention: true,
      }),
      result({
        path: 'assets/huge.png',
        outputPath: 'assets/huge.png',
        status: 'failed',
        applied: [],
        plan: plan({ path: 'assets/huge.png', targetPath: 'assets/huge.png' }),
        before: { bytes: 900_000, width: 3000, height: 3000, format: 'png' },
        reason: 'PNG is lossless, so a maximum-effort re-encode is the only lever',
        needsAttention: true,
      }),
    ],
    unrecovered: [],
    reviewRecorded: false,
    diagnostics: [],
  };
}
