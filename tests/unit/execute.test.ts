import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createResolver } from '../../src/config/resolve.js';
import { TempRegistry } from '../../src/operations/atomic.js';
import { executeFile, skipReasonFor, statusForSkip, verifyCandidate } from '../../src/operations/execute.js';
import type { ExecuteContext } from '../../src/operations/execute.js';
import { planFile } from '../../src/operations/plan.js';
import { evaluate } from '../../src/policy/evaluate.js';
import { inspectBuffer } from '../../src/scanner/inspect.js';
import { sha256 } from '../../src/utils/hash.js';
import { createStopFlag } from '../../src/utils/signal.js';
import { cleanupProjects, copyProject, FIXTURE_IMAGES, residue } from '../helpers/project.js';
import type {
  EncodeOutcome,
  FilePlan,
  FileResult,
  ImageFormat,
  ImageInfo,
  Policy,
} from '../../src/types.js';

afterEach(cleanupProjects);

/**
 * The executor, with the encoder replaced.
 *
 * Every property worth pinning down here is about what happens *around* the
 * encode - what is written, what is refused, what is left alone - so the
 * encoder is a stub returning whatever bytes the test wants. That makes the
 * verification-rejection case, which is otherwise nearly impossible to provoke
 * on purpose, a two-line test.
 */

function policyOf(rules: Policy['rules']): Policy {
  return { version: 1, defaults: {}, rules };
}

async function fileResult(root: string, relativePath: string, policy: Policy): Promise<FileResult> {
  const bytes = fs.readFileSync(path.join(root, relativePath));
  const inspected = await inspectBuffer(relativePath, bytes);
  if (!inspected.ok) throw new Error(inspected.error);
  const resolver = createResolver(policy);
  return evaluate(inspected.info, resolver.resolve(relativePath), resolver.globs());
}

function contextFor(root: string, policy: Policy, render?: ExecuteContext['render']): ExecuteContext {
  const resolver = createResolver(policy);
  const context: ExecuteContext = {
    root,
    resolver,
    allGlobs: resolver.globs(),
    semantics: 'case-sensitive',
    permissions: { allowRenames: true },
    registry: new TempRegistry(),
    stop: createStopFlag(),
    backupDir: undefined,
    reviewDir: undefined,
  };
  if (render !== undefined) context.render = render;
  return context;
}

/**
 * A render stub, in the shape the real pipeline returns.
 *
 * The tests that use one care about what happens *around* the encode, so the
 * quality outcome is whatever the test needs it to be - including absent, which
 * is what a PNG render reports.
 */
function renders(
  buffer: Buffer,
  format: ImageFormat = 'png',
  quality?: EncodeOutcome['quality'],
): ExecuteContext['render'] {
  return async () => ({ buffer, format, bytes: buffer.length, quality });
}

/** A project holding one fixture image under `assets/`, plus its policy. */
function projectWith(image: string, as: string): string {
  const root = copyProject('clean');
  for (const entry of fs.readdirSync(path.join(root, 'assets'))) {
    fs.unlinkSync(path.join(root, 'assets', entry));
  }
  fs.copyFileSync(path.join(FIXTURE_IMAGES, image), path.join(root, 'assets', as));
  return root;
}

describe('skipReasonFor', () => {
  const base: FilePlan = {
    path: 'a.png',
    targetPath: 'a.png',
    status: 'unchanged',
    operations: [],
    blockedOperations: [],
    resolves: [],
    unresolved: [],
    normalizedDuringRewrite: [],
    warnings: [],
    requiresVerification: false,
    requiredPermissions: [],
    reasons: [],
    notes: [],
  };

  it('has no reason for a plan that will be executed', () => {
    expect(skipReasonFor({ ...base, status: 'unchanged' })).toBeUndefined();
    expect(skipReasonFor({ ...base, status: 'planned' })).toBeUndefined();
  });

  it('executes a budget-driven plan like any other', () => {
    // The regression test for the branch this phase removed. A plan whose
    // encode exists to meet `maxBytes` goes down the same path as every other
    // planned file; whether its output may be written is verification's call.
    const plan: FilePlan = {
      ...base,
      status: 'planned',
      operations: [
        {
          op: 'encode',
          format: 'jpeg',
          budgetDriven: true,
          maxBytes: 1024,
          quality: { start: 82, floor: 40 },
          stripMetadata: true,
          preserveAlpha: false,
          lossyReencode: true,
          outcomeRequiresVerification: true,
          preservesOrientation: false,
        },
      ],
    };
    expect(skipReasonFor(plan)).toBeUndefined();
  });

  it('names the permission a plan is waiting on', () => {
    const plan: FilePlan = {
      ...base,
      status: 'requires-permission',
      requiredPermissions: ['allowRenames'],
      reasons: ['correcting the extension renames this file'],
    };
    expect(skipReasonFor(plan)).toBe(
      'correcting the extension renames this file; rerun with --allow-renames',
    );
  });

  it('quotes the reason for every other non-executing status', () => {
    for (const status of ['blocked', 'unfixable', 'unsupported'] as const) {
      expect(skipReasonFor({ ...base, status, reasons: ['because'] })).toBe('because');
    }
  });

  it('maps a decode failure to failed and everything else to skipped', () => {
    expect(statusForSkip({ ...base, status: 'blocked' })).toBe('blocked');
    expect(statusForSkip({ ...base, status: 'unfixable', unresolved: ['decode'] })).toBe('failed');
    expect(statusForSkip({ ...base, status: 'unfixable', unresolved: ['format'] })).toBe('skipped');
    expect(statusForSkip({ ...base, status: 'unsupported' })).toBe('skipped');
  });
});

describe('executeFile', () => {
  it('executes a budget-driven plan and reports the quality the search chose', async () => {
    const root = projectWith('overbudget.jpg', 'heavy.jpg');
    const policy = policyOf([{ glob: 'assets/**', body: { maxBytes: 200 * 1024 } }]);
    const before = await fileResult(root, 'assets/heavy.jpg', policy);
    const plan = planFile(before, { allowRenames: true });

    const result = await executeFile(contextFor(root, policy), plan, before);

    expect(result.status).toBe('fixed');
    expect(result.needsAttention).toBe(false);
    expect(result.encode?.quality?.searched).toBe(true);
    expect(result.encode?.quality?.chosen).toBeLessThan(82);
    expect(result.after?.bytes).toBeLessThanOrEqual(200 * 1024);
    expect(fs.statSync(path.join(root, 'assets', 'heavy.jpg')).size).toBe(result.after?.bytes);
  });

  it('never re-encodes a file that is already inside its budget', async () => {
    // Structural, not a check inside the search: a compliant file gets an empty
    // plan from `planFile` and never reaches the encoder at all.
    const root = projectWith('sample.webp', 'small.webp');
    const policy = policyOf([{ glob: 'assets/**', body: { maxBytes: 150 * 1024 } }]);
    const before = await fileResult(root, 'assets/small.webp', policy);
    const plan = planFile(before, { allowRenames: true });
    expect(plan.status).toBe('unchanged');

    const render = vi.fn();
    const result = await executeFile(contextFor(root, policy, render), plan, before);

    expect(render).not.toHaveBeenCalled();
    expect(result.status).toBe('unchanged');
    expect(result.encode).toBeUndefined();
  });

  it('names the floor, the best size and the remedies when no quality fits', async () => {
    const root = projectWith('overbudget.jpg', 'heavy.jpg');
    const policy = policyOf([{ glob: 'assets/**', body: { maxBytes: 20 * 1024 } }]);
    const before = await fileResult(root, 'assets/heavy.jpg', policy);
    const plan = planFile(before, { allowRenames: true });
    const original = fs.readFileSync(path.join(root, 'assets', 'heavy.jpg'));

    const result = await executeFile(contextFor(root, policy), plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/cannot reach 20 KB at 700x700 without dropping below quality 40/);
    expect(result.reason).toMatch(/best: [\d.]+ KB at quality 40/);
    expect(result.reason).toMatch(/Raise maxBytes, lower maxWidth or maxHeight, or allow webp/);
    // The failure still reports what the encoder managed, which is the half of
    // the message a user acts on.
    expect(result.encode?.quality?.chosen).toBe(40);
    expect(result.encode?.bytes).toBeGreaterThan(20 * 1024);
    expect(sha256(fs.readFileSync(path.join(root, 'assets', 'heavy.jpg')))).toBe(sha256(original));
  });

  it('says PNG is lossless rather than pretending a search was possible', async () => {
    // The re-encode here comes back no smaller than the source, which is a
    // different thing to tell the user than "not small enough": there is
    // nothing left for a rerun to find.
    const root = projectWith('noisy.png', 'noisy.png');
    const policy = policyOf([{ glob: 'assets/**', body: { maxBytes: 200 * 1024 } }]);
    const before = await fileResult(root, 'assets/noisy.png', policy);
    const plan = planFile(before, { allowRenames: true });
    const original = fs.readFileSync(path.join(root, 'assets', 'noisy.png'));

    const result = await executeFile(contextFor(root, policy), plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/PNG is lossless, so a maximum-effort re-encode is the only lever/);
    expect(result.reason).toMatch(
      /the lossless re-encode is [\d.]+ KB at 400x400, no smaller than the file already is, so PNG cannot get this image under the 200 KB ceiling/,
    );
    expect(result.reason).toMatch(/set format: webp for this glob, which keeps transparency/);
    expect(result.encode?.quality).toBeUndefined();
    expect(sha256(fs.readFileSync(path.join(root, 'assets', 'noisy.png')))).toBe(sha256(original));
  });

  it('says the PNG re-encode got smaller but not small enough when it did', async () => {
    // The other half of the same message. Provoked with a stub, because a
    // fixture that compresses by exactly the wrong amount would be pinning the
    // test to libvips' output size rather than to the branch under test.
    const root = projectWith('noisy.png', 'noisy.png');
    const policy = policyOf([{ glob: 'assets/**', body: { maxBytes: 200 * 1024 } }]);
    const before = await fileResult(root, 'assets/noisy.png', policy);
    const plan = planFile(before, { allowRenames: true });
    const smaller = fs.readFileSync(path.join(FIXTURE_IMAGES, 'screenshot.png'));
    expect(smaller.length).toBeLessThan(before.image?.bytes ?? 0);

    const context = contextFor(root, policy, renders(smaller, 'png'));
    const result = await executeFile(context, plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/PNG is lossless, so a maximum-effort re-encode is the only lever/);
    expect(result.reason).toMatch(/it produced [\d.]+ KB at 480x360, still over the 200 KB ceiling/);
    expect(result.reason).not.toMatch(/no smaller than the file already is/);
    expect(result.reason).toMatch(/set format: webp for this glob, which keeps transparency/);
  });

  it('says which single quality was tried when the floor leaves no band', async () => {
    // `floor === start` is a legal config, and the search then has nothing to
    // descend through. Reporting it as "without dropping below quality 82"
    // would describe a descent that never happened.
    const root = projectWith('overbudget.jpg', 'heavy.jpg');
    const policy = policyOf([
      { glob: 'assets/**', body: { maxBytes: 20 * 1024, quality: { start: 82, floor: 82 } } },
    ]);
    const before = await fileResult(root, 'assets/heavy.jpg', policy);
    const plan = planFile(before, { allowRenames: true });

    const result = await executeFile(contextFor(root, policy), plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/was the only quality tried/);
    expect(result.reason).toMatch(/quality\.floor to 82 and quality\.start to 82/);
    expect(result.reason).toMatch(/Lower quality\.floor/);
    expect(result.reason).not.toMatch(/without dropping below/);
    expect(result.encode?.quality?.attempts).toBe(1);
  });

  it('does not suggest WebP to a file that is already WebP', async () => {
    const root = projectWith('noisy-alpha.webp', 'alpha.webp');
    const policy = policyOf([{ glob: 'assets/**', body: { maxBytes: 4 * 1024 } }]);
    const before = await fileResult(root, 'assets/alpha.webp', policy);
    const plan = planFile(before, { allowRenames: true });

    const result = await executeFile(contextFor(root, policy), plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/Raise maxBytes, or lower maxWidth or maxHeight\./);
    expect(result.reason).not.toMatch(/webp/);
  });

  it('writes exactly one buffer for a successful budget fix', async () => {
    const root = projectWith('overbudget.jpg', 'heavy.jpg');
    const policy = policyOf([{ glob: 'assets/**', body: { maxBytes: 200 * 1024 } }]);
    const before = await fileResult(root, 'assets/heavy.jpg', policy);
    const plan = planFile(before, { allowRenames: true });

    const result = await executeFile(contextFor(root, policy), plan, before);

    expect(result.status).toBe('fixed');
    // Several qualities were encoded; exactly one of them reached the disk.
    expect((result.encode?.quality?.attempts ?? 0)).toBeGreaterThan(1);
    expect(fs.readdirSync(path.join(root, 'assets'))).toEqual(['heavy.jpg']);
    expect(residue(root)).toEqual([]);
  });

  it('leaves the original untouched when the candidate fails verification', async () => {
    const root = projectWith('oversized.jpg', 'wide.jpg');
    const policy = policyOf([{ glob: 'assets/**', body: { maxWidth: 800 } }]);
    const before = await fileResult(root, 'assets/wide.jpg', policy);
    const plan = planFile(before, { allowRenames: true });
    const original = fs.readFileSync(path.join(root, 'assets', 'wide.jpg'));

    // The encoder "succeeds" and hands back bytes that are still too wide.
    const context = contextFor(root, policy, renders(original, 'jpeg'));
    const result = await executeFile(context, plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/2000 px wide/);
    expect(sha256(fs.readFileSync(path.join(root, 'assets', 'wide.jpg')))).toBe(sha256(original));
    expect(context.registry.paths()).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'assets'))).toEqual(['wide.jpg']);
  });

  it('reports identical candidate bytes as unchanged and writes nothing', async () => {
    // An encoder that reproduces its input exactly, on a file that does need a
    // rewrite. Nothing changed, so nothing is written - but only because the
    // bytes were verified first.
    const root = projectWith('plain.png', 'plain.png');
    const policy = policyOf([{ glob: 'assets/**', body: { maxWidth: 400, stripMetadata: true } }]);
    const before = await fileResult(root, 'assets/plain.png', policy);
    const plan: FilePlan = {
      ...planFile(before, { allowRenames: true }),
      status: 'planned',
      operations: [
        {
          op: 'encode',
          format: 'png',
          budgetDriven: false,
          stripMetadata: true,
          preserveAlpha: false,
          lossyReencode: false,
          outcomeRequiresVerification: false,
          preservesOrientation: false,
        },
      ],
    };
    const original = fs.readFileSync(path.join(root, 'assets', 'plain.png'));
    const mtime = fs.statSync(path.join(root, 'assets', 'plain.png')).mtimeMs;

    const result = await executeFile(contextFor(root, policy, renders(original)), plan, before);

    expect(result.status).toBe('unchanged');
    expect(result.after).toBeUndefined();
    expect(fs.statSync(path.join(root, 'assets', 'plain.png')).mtimeMs).toBe(mtime);
  });

  it('fails when the encoder produces a different format from the plan', async () => {
    const root = projectWith('plain.png', 'plain.png');
    const policy = policyOf([{ glob: 'assets/**', body: { maxWidth: 200 } }]);
    const before = await fileResult(root, 'assets/plain.png', policy);
    const plan = planFile(before, { allowRenames: true });
    const jpeg = fs.readFileSync(path.join(FIXTURE_IMAGES, 'compliant.jpg'));

    const result = await executeFile(contextFor(root, policy, renders(jpeg, 'jpeg')), plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/produced jpeg where the plan says png/);
  });

  it('fails when an encode required to preserve transparency loses it', async () => {
    const root = projectWith('transparent.png', 'logo.png');
    const policy = policyOf([{ glob: 'assets/**', body: { maxWidth: 200 } }]);
    const before = await fileResult(root, 'assets/logo.png', policy);
    const plan = planFile(before, { allowRenames: true });
    expect(plan.operations.some((op) => op.op === 'encode' && op.preserveAlpha)).toBe(true);

    const flattened = fs.readFileSync(path.join(FIXTURE_IMAGES, 'plain.png'));
    const result = await executeFile(contextFor(root, policy, renders(flattened)), plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/preserve transparency and the output has none/);
  });

  it('does not call the encoder for a rename that touches no pixels', async () => {
    const root = projectWith('webp-named-png.png', 'logo.png');
    const policy = policyOf([{ glob: 'assets/**', body: {} }]);
    const before = await fileResult(root, 'assets/logo.png', policy);
    const plan = planFile(before, { allowRenames: true });
    expect(plan.operations.map((op) => op.op)).toEqual(['rename']);

    const render = vi.fn();
    const result = await executeFile(contextFor(root, policy, render), plan, before);

    expect(render).not.toHaveBeenCalled();
    expect(result.status).toBe('fixed');
    expect(result.outputPath).toBe('assets/logo.webp');
    expect(fs.existsSync(path.join(root, 'assets', 'logo.webp'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'assets', 'logo.png'))).toBe(false);
  });

  it('refuses a plan whose file changed after it was planned', async () => {
    const root = projectWith('oversized.jpg', 'wide.jpg');
    const policy = policyOf([{ glob: 'assets/**', body: { maxWidth: 800 } }]);
    const before = await fileResult(root, 'assets/wide.jpg', policy);
    const plan = planFile(before, { allowRenames: true });

    // Somebody edited the file between `check` and the write. Every decision in
    // the plan describes bytes that are no longer there.
    const replacement = fs.readFileSync(path.join(FIXTURE_IMAGES, 'compliant.jpg'));
    fs.writeFileSync(path.join(root, 'assets', 'wide.jpg'), replacement);

    const render = vi.fn();
    const result = await executeFile(contextFor(root, policy, render), plan, before);

    expect(render).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/changed on disk after this run planned it/);
    expect(sha256(fs.readFileSync(path.join(root, 'assets', 'wide.jpg')))).toBe(sha256(replacement));
  });

  it('refuses a rename-only plan whose file changed, before renaming anything', async () => {
    const root = projectWith('webp-named-png.png', 'logo.png');
    const policy = policyOf([{ glob: 'assets/**', body: {} }]);
    const before = await fileResult(root, 'assets/logo.png', policy);
    const plan = planFile(before, { allowRenames: true });
    expect(plan.operations.map((op) => op.op)).toEqual(['rename']);

    fs.writeFileSync(
      path.join(root, 'assets', 'logo.png'),
      fs.readFileSync(path.join(FIXTURE_IMAGES, 'plain.png')),
    );

    const result = await executeFile(contextFor(root, policy), plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/changed on disk after this run planned it/);
    expect(fs.existsSync(path.join(root, 'assets', 'logo.png'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'assets', 'logo.webp'))).toBe(false);
  });

  it('reports an unexpected throw as a failure rather than rejecting', async () => {
    // A rejected promise would take down the whole worker pool and turn one bad
    // file into an aborted batch, which is the opposite of per-file isolation.
    const root = projectWith('oversized.jpg', 'wide.jpg');
    const policy = policyOf([{ glob: 'assets/**', body: { maxWidth: 800 } }]);
    const before = await fileResult(root, 'assets/wide.jpg', policy);
    const plan = planFile(before, { allowRenames: true });

    const context = contextFor(root, policy, () => {
      throw new Error('the encoder exploded');
    });
    const result = await executeFile(context, plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('the encoder exploded');
    expect(result.needsAttention).toBe(true);
  });

  it('reports a throw from outside the guarded steps as a failure too', async () => {
    const root = projectWith('oversized.jpg', 'wide.jpg');
    const policy = policyOf([{ glob: 'assets/**', body: { maxWidth: 800 } }]);
    const before = await fileResult(root, 'assets/wide.jpg', policy);
    const plan = planFile(before, { allowRenames: true });

    const context = contextFor(root, policy);
    // The resolver is consulted after the candidate is verified, well outside
    // any of the individual try/catch blocks.
    context.resolver = {
      ...context.resolver,
      resolve: () => {
        throw new Error('policy resolution exploded');
      },
    };

    const result = await executeFile(context, plan, before);

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('policy resolution exploded');
  });

  it('stops before reading anything once the stop flag is set', async () => {
    const root = projectWith('oversized.jpg', 'wide.jpg');
    const policy = policyOf([{ glob: 'assets/**', body: { maxWidth: 800 } }]);
    const before = await fileResult(root, 'assets/wide.jpg', policy);
    const plan = planFile(before, { allowRenames: true });

    const render = vi.fn();
    const context = contextFor(root, policy, render);
    context.stop.requested = true;
    const result = await executeFile(context, plan, before);

    expect(render).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('interrupted before this file was reached');
  });
});

describe('verifyCandidate', () => {
  async function verify(image: string, target: string, rules: Policy['rules'], plan: FilePlan) {
    const bytes = fs.readFileSync(path.join(FIXTURE_IMAGES, image));
    const inspected = await inspectBuffer(target, bytes);
    if (!inspected.ok) throw new Error(inspected.error);
    const resolver = createResolver(policyOf(rules));
    return verifyCandidate(inspected.info as ImageInfo, plan, resolver.resolve(target), resolver.globs());
  }

  const renameOnly: FilePlan = {
    path: 'assets/a.jpg',
    targetPath: 'assets/a.png',
    status: 'planned',
    operations: [{ op: 'rename', from: 'assets/a.jpg', to: 'assets/a.png', reason: 'format-conversion', reencode: false }],
    blockedOperations: [],
    resolves: [],
    unresolved: [],
    normalizedDuringRewrite: [],
    warnings: [],
    requiresVerification: false,
    requiredPermissions: [],
    reasons: [],
    notes: [],
  };

  it('tolerates a pixel-level error a pixel-free rename never claimed to fix', async () => {
    // deep16.png is 1600 px wide and the target rule allows 800. The rename
    // corrects the extension and touches nothing else; refusing it would leave
    // the file permanently mis-named with no remedy at all.
    const verification = await verify('deep16.png', 'assets/a.png', [
      { glob: 'assets/*.png', body: { maxWidth: 800 } },
    ], renameOnly);

    expect(verification.blocking).toEqual([]);
    expect(verification.tolerated.map((finding) => finding.check)).toEqual(['maxWidth']);
  });

  it('still blocks a rename whose new extension disagrees with the contents', async () => {
    const verification = await verify('deep16.png', 'assets/a.jpg', [
      { glob: 'assets/*', body: {} },
    ], { ...renameOnly, targetPath: 'assets/a.jpg' });

    expect(verification.tolerated).toEqual([]);
    expect(verification.blocking.map((finding) => finding.check)).toEqual(['extension']);
  });

  it('blocks every error when the run produced the bytes', async () => {
    const withEncode: FilePlan = {
      ...renameOnly,
      targetPath: 'assets/a.png',
      operations: [
        {
          op: 'encode',
          format: 'png',
          budgetDriven: false,
          stripMetadata: true,
          preserveAlpha: false,
          lossyReencode: false,
          outcomeRequiresVerification: false,
          preservesOrientation: false,
        },
        { op: 'rename', from: 'assets/a.jpg', to: 'assets/a.png', reason: 'format-conversion', reencode: true },
      ],
    };

    const verification = await verify('deep16.png', 'assets/a.png', [
      { glob: 'assets/*.png', body: { maxWidth: 800 } },
    ], withEncode);

    expect(verification.tolerated).toEqual([]);
    expect(verification.blocking.map((finding) => finding.check)).toEqual(['maxWidth']);
  });
});
