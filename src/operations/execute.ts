import fsp from 'node:fs/promises';

import { backupOriginal } from './backup.js';
import { commitRename, convertAndReplace, writeCandidate, type TempRegistry } from './atomic.js';
import { renderCandidate } from './pipeline.js';
import { EXTENSION_FORMATS } from '../policy/rules/extension.js';
import { hasMeaningfulAlpha } from '../policy/rules/types.js';
import { evaluate } from '../policy/evaluate.js';
import { inspectBuffer } from '../scanner/inspect.js';
import { formatBytes } from '../utils/bytes.js';
import { sha256 } from '../utils/hash.js';
import { toAbsolute } from '../utils/paths.js';
import type { PathSemantics } from './plan-set.js';
import type { Resolver } from '../config/resolve.js';
import type { StopFlag } from '../utils/signal.js';
import type {
  EffectiveRule,
  EncodeOperation,
  FilePlan,
  FileResult,
  Finding,
  FixMeasurement,
  FixPermissions,
  FixResult,
  ImageFormat,
  ImageInfo,
  PlannedOperation,
} from '../types.js';

/**
 * One file, executed.
 *
 * The invariant this module exists to hold, from 04 section 8 and 17.10:
 *
 *   **the original is byte-for-byte untouched until a candidate has been
 *   generated in memory, inspected by the same inspector the read path uses,
 *   and evaluated against the policy of the path it is going to live at.**
 *
 * Everything else here is arranged around that sentence. The candidate is a
 * Buffer, never a temp file, so a crash during verification cannot leave
 * something on disk that nothing has vouched for. The rule is resolved for the
 * *target* path, because a rename can move a file out from under the rule that
 * governed it and into another one. The write happens last, once, atomically.
 *
 * ## Failure is per file
 *
 * A file either fully succeeds or is left exactly as it was, so there is no
 * partial state and therefore no rollback machinery. A decode failure, a
 * verification failure or a refused backup fails that one file and the batch
 * continues. The run's exit code reports it; nothing else is affected.
 */

export interface ExecuteContext {
  root: string;
  resolver: Resolver;
  /** `resolver.globs()`, hoisted once: every file needs it and it never changes. */
  allGlobs: string[];
  semantics: PathSemantics;
  permissions: FixPermissions;
  registry: TempRegistry;
  stop: StopFlag;
  /** Absolute, already validated. Undefined unless `--backup-dir` was given. */
  backupDir: string | undefined;
  /** Injection point for tests. Production always uses the real pipeline. */
  render?: typeof renderCandidate;
}

/**
 * Why this plan will not be executed, or undefined if it will.
 *
 * Pure, and deliberately separate from `executeFile`: the whole status mapping
 * is then testable without a filesystem, an image, or an encoder. The one
 * non-executing case it cannot cover is the stop flag, which is a property of
 * the run rather than of the plan.
 */
export function skipReasonFor(plan: FilePlan): string | undefined {
  switch (plan.status) {
    case 'unchanged':
      return undefined;

    case 'planned': {
      const encode = operationOf(plan, 'encode');
      if (encode?.budgetDriven === true) {
        return 'the byte-budget search is not implemented yet, so this file is left as it is';
      }
      return undefined;
    }

    case 'requires-permission':
      return `${plan.reasons[0] ?? 'this plan needs a permission it was not given'}; rerun with --allow-renames`;

    case 'blocked':
    case 'unfixable':
    case 'unsupported':
      return plan.reasons[0] ?? `the plan is ${plan.status}`;
  }
}

/**
 * The status a non-executing plan reports.
 *
 * An undecodable file is `failed` rather than `skipped`, per 04 section 8: a
 * corrupt image is a broken file, not a policy Rasterwright declined to apply,
 * and burying it among the files that merely need a flag would hide the one
 * result the user has to go and look at. Every other `unfixable` plan - a JPEG
 * target on an image with real transparency, say - is a refusal on purpose and
 * stays `skipped`.
 */
export function statusForSkip(plan: FilePlan): FixResult['status'] {
  if (plan.status === 'blocked') return 'blocked';
  if (plan.status === 'unfixable' && plan.unresolved.includes('decode')) return 'failed';
  return 'skipped';
}

export interface Verification {
  /** Error-level findings that refuse the write outright. */
  blocking: Finding[];
  /**
   * Error-level findings the write does not resolve and did not cause. Only
   * ever non-empty for a rename-only plan; see the carve-out below.
   */
  tolerated: Finding[];
  /** Failures the policy language cannot express, as ready-made messages. */
  assertions: string[];
}

/**
 * Decide whether the bytes about to be written are acceptable.
 *
 * No filesystem access: `candidate` is the `ImageInfo` of bytes that exist only
 * in memory, and `rule` is the effective policy of the path they are going to.
 *
 * ## The default is strict, and stays strict
 *
 * If this run *encoded* something, those bytes are committed only when the
 * evaluation produces no error-level finding at all. An encode that leaves the
 * file over `maxBytes`, still too wide, or still non-sRGB has not fixed the
 * file, and writing it would replace a known-bad file with a differently
 * known-bad file while reporting success.
 *
 * ## The one carve-out: a rename that touches no pixels
 *
 * A `planned` plan whose only operation is a `rename` with `reencode: false`
 * moves the user's existing bytes to the name policy says they must have. It
 * produces nothing, so there is nothing it could have produced badly. Refusing
 * it because the pixels are *also* wrong in a way the rename never claimed to
 * address leaves the file permanently mis-named with no remedy: no flag and no
 * config change resolves it, because any plan that would re-encode those pixels
 * is refused for an unrelated reason.
 *
 * Three checks stay blocking even there, because they are the only ones the
 * rename itself can be wrong about: `decode` (the bytes are not an image),
 * `extension` (the new name still disagrees with the contents) and `format`
 * (the contents are not what the target rule demands). Everything else -
 * `maxWidth`, `maxHeight`, `maxBytes`, `colorSpace`, `orientation` - describes
 * pixels the rename did not touch and which were already in that state before
 * the run started.
 *
 * A tolerated finding is never silent: it sets `needsAttention` on the result,
 * so the file is listed in the report and the run exits 1.
 */
export function verifyCandidate(
  candidate: ImageInfo,
  plan: FilePlan,
  rule: EffectiveRule,
  allGlobs: string[],
): Verification {
  const evaluated = evaluate(candidate, rule, allGlobs);
  const errors = evaluated.findings.filter((finding) => finding.severity === 'error');
  const assertions: string[] = [];

  const encode = operationOf(plan, 'encode');
  if (encode !== undefined) {
    // The encoder produced a format the plan did not describe. Nothing
    // downstream is true any more, including the target filename.
    if (candidate.format !== encode.format) {
      assertions.push(
        `the encoder produced ${candidate.format} where the plan says ${encode.format}`,
      );
    }
    // The other half of the pipeline's refusal to encode an alpha image as
    // JPEG (17.13), checked on the output side: a silent flatten turns a logo
    // into a black box and cannot be undone from the result.
    if (encode.preserveAlpha && !hasMeaningfulAlpha(candidate)) {
      assertions.push('the encode was required to preserve transparency and the output has none');
    }
  }

  if (encode !== undefined || !isRenameOnly(plan)) {
    return { blocking: errors, tolerated: [], assertions };
  }

  const blocking = errors.filter((finding) => RENAME_BLOCKING.has(finding.check));
  return {
    blocking,
    tolerated: errors.filter((finding) => !RENAME_BLOCKING.has(finding.check)),
    assertions,
  };
}

/** The only checks a pixel-free rename can itself be wrong about. */
const RENAME_BLOCKING: ReadonlySet<Finding['check']> = new Set<Finding['check']>([
  'decode',
  'extension',
  'format',
]);

/** A plan that moves the file and changes nothing inside it. */
function isRenameOnly(plan: FilePlan): boolean {
  return (
    plan.operations.length === 1 &&
    plan.operations[0]?.op === 'rename' &&
    plan.operations[0].reencode === false
  );
}

/**
 * The reason an interrupted run gives for every file it never reached.
 *
 * Exported because the summary has to count those results separately from the
 * files it genuinely skipped, and a string literal repeated in two modules is a
 * string literal that will eventually differ in one of them.
 */
export const INTERRUPTED_REASON = 'interrupted before this file was reached';

/**
 * Execute one plan, or explain why it was not executed.
 *
 * `before` is `check`'s result for the same path, which is where the original's
 * measurements come from.
 *
 * **Never throws.** Every failure, including one nothing here anticipated,
 * becomes a `failed` result. A rejected promise would take down the whole
 * `mapWithConcurrency` pool and turn one bad file into an aborted batch that
 * exits 2, which is precisely the opposite of the per-file failure isolation
 * 04 section 8 asks for.
 */
export async function executeFile(
  ctx: ExecuteContext,
  plan: FilePlan,
  before: FileResult | undefined,
): Promise<FixResult> {
  const measured = measurementOf(plan, before);

  // 1. The run is stopping. Checked first so an interrupt costs nothing per
  //    remaining file, and so no file is opened after the user asked us to stop.
  if (ctx.stop.requested) return outcome(plan, 'skipped', measured, INTERRUPTED_REASON);

  // 2. Plans this run will not execute. No filesystem access at all.
  if (plan.status === 'unchanged') return outcome(plan, 'unchanged', measured);
  const skip = skipReasonFor(plan);
  if (skip !== undefined) return outcome(plan, statusForSkip(plan), measured, skip);

  try {
    return await executePlanned(ctx, plan, before, measured);
  } catch (error) {
    // The catch-all. Everything below it already reports its own failures, so
    // reaching here means something happened that nobody thought of - and the
    // right answer to that is still "fail this file and keep going".
    return outcome(plan, 'failed', measured, messageOf(error));
  }
}

/** The body of `executeFile` for a plan that is going to be executed. */
async function executePlanned(
  ctx: ExecuteContext,
  plan: FilePlan,
  before: FileResult | undefined,
  measured: FixMeasurement,
): Promise<FixResult> {
  const absoluteSource = toAbsolute(ctx.root, plan.path);
  const absoluteTarget = toAbsolute(ctx.root, plan.targetPath);

  // 3. Read the original once. Its bytes are the encoder's input, the backup's
  //    contents, and (for a rename-only plan) the verified output.
  let source: Buffer;
  let mode: number;
  try {
    source = await fsp.readFile(absoluteSource);
    mode = (await fsp.stat(absoluteSource)).mode;
  } catch (error) {
    return outcome(plan, 'failed', measured, `could not read the original: ${messageOf(error)}`);
  }

  // 4. The plan describes the file `check` inspected. If the bytes on disk are
  //    no longer those bytes, every decision in the plan was made about a file
  //    that no longer exists: the dimensions, the format, the orientation and
  //    the transparency all came from the old contents. Rendering the new bytes
  //    through the old plan would apply a resize computed for a different image
  //    and, worse, overwrite an edit somebody made while the run was in flight.
  //    Cheap to detect, because `check` already hashed what it read.
  const planned = before?.image?.contentHash;
  if (planned !== undefined && planned !== sha256(source)) {
    return outcome(
      plan,
      'failed',
      measured,
      'the file changed on disk after this run planned it, so the plan no longer describes it; ' +
        'rerun fix',
    );
  }

  const encode = operationOf(plan, 'encode');

  // 5. Produce the candidate. A truncated JPEG only fails here, inside
  //    `toBuffer()` (17.18), so the decoder's own message is what gets reported.
  let candidate: Buffer;
  if (encode === undefined) {
    candidate = source;
  } else {
    try {
      const render = ctx.render ?? renderCandidate;
      candidate = await render(source, plan, requireImage(before, plan));
    } catch (error) {
      return outcome(plan, 'failed', measured, messageOf(error));
    }
  }

  // 6. Inspect the candidate as the file it is about to become. The target path
  //    is the label, because that is the name the extension check has to agree
  //    with and the name the rule was resolved for.
  const inspected = await inspectBuffer(plan.targetPath, candidate);
  if (!inspected.ok) {
    return outcome(plan, 'failed', measured, `the candidate could not be inspected: ${inspected.error}`);
  }

  // 7. Verify against the policy of where the bytes are going, not where they
  //    came from: a rename can move a file into another rule's jurisdiction.
  const rule = ctx.resolver.resolve(plan.targetPath);
  const verification = verifyCandidate(inspected.info, plan, rule, ctx.allGlobs);
  if (verification.assertions.length > 0) {
    return outcome(plan, 'failed', measured, verification.assertions.join('; '));
  }
  if (verification.blocking.length > 0) {
    return outcome(plan, 'failed', measured, refusalFor(verification.blocking, encode));
  }

  // 8. Bytes that did not change are not worth writing. This is checked *after*
  //    verification on purpose: an encoder that faithfully reproduced bytes
  //    which are still in violation must be reported as a failure, not as a
  //    success that happened to need no write.
  const unchangedInPlace =
    plan.targetPath === plan.path && inspected.info.contentHash === sha256(source);
  if (unchangedInPlace) return outcome(plan, 'unchanged', measured);

  // 9. Everything below writes.
  if (ctx.backupDir !== undefined) {
    try {
      await backupOriginal(ctx.backupDir, plan.path, source);
    } catch (error) {
      return outcome(plan, 'failed', measured, messageOf(error));
    }
  }

  // BEFORE-COPY CALL SITE (04 section 17.7). `review` keeps a copy of every
  // original it touched; the bytes are already in `source`, so retaining one is
  // a single insertion here. Deliberately not implemented in this phase: a
  // second write surface brings its own partial states, and this phase's claim
  // is that nothing partial is ever left on disk.

  try {
    if (encode === undefined) {
      await commitRename(absoluteSource, absoluteTarget, { semantics: ctx.semantics });
    } else if (plan.targetPath === plan.path) {
      await writeCandidate(absoluteTarget, candidate, { mode, registry: ctx.registry });
    } else {
      await convertAndReplace(absoluteSource, absoluteTarget, candidate, mode, ctx.registry);
    }
  } catch (error) {
    return outcome(plan, 'failed', measured, messageOf(error));
  }

  const after: FixMeasurement = {
    bytes: inspected.info.bytes,
    width: inspected.info.width,
    height: inspected.info.height,
    format: inspected.info.format,
  };

  const result = outcome(plan, 'fixed', measured);
  result.applied = plan.operations.map((operation) => operation.op);
  result.after = after;
  result.savingsPct =
    measured.bytes === 0 ? 0 : ((measured.bytes - after.bytes) / measured.bytes) * 100;
  result.warnings = verification.tolerated.map((finding) => finding.message);
  result.needsAttention = verification.tolerated.length > 0;
  return result;
}

/**
 * How a refused candidate is described.
 *
 * A missed byte ceiling gets its own sentence. The raw `maxBytes` finding says
 * the file is too big, which reads as a bug when the user just asked
 * Rasterwright to make it smaller; what actually happened is that the single
 * encode at `quality.start` was not enough and the search that would go lower
 * does not exist yet.
 */
function refusalFor(blocking: readonly Finding[], encode: EncodeOperation | undefined): string {
  const ceiling = blocking.find((finding) => finding.check === 'maxBytes');
  if (ceiling !== undefined && encode !== undefined) {
    const at =
      encode.quality === undefined
        ? 'a maximum-effort lossless re-encode'
        : `quality ${encode.quality.start}`;
    const actual = typeof ceiling.actual === 'number' ? formatBytes(ceiling.actual) : `${ceiling.actual}`;
    const allowed =
      typeof ceiling.allowed === 'number' ? formatBytes(ceiling.allowed) : `${ceiling.allowed}`;
    return (
      `${at} produced ${actual}, which is still over the ${allowed} ceiling; ` +
      'the byte-budget quality search is not implemented yet, so the original is left as it is'
    );
  }
  return blocking.map((finding) => finding.message).join('; ');
}

/**
 * A skeleton result. Callers fill in what a success adds.
 *
 * `needsAttention` is the single predicate the exit code and the report
 * ordering both read: an error-level finding is still outstanding after this
 * run. Every `failed`, `blocked` and `skipped` plan leaves `plan.unresolved`
 * non-empty by construction, and `unchanged` never does, because `planFile()`
 * only returns `unchanged` for a file with no error-level findings at all.
 */
function outcome(
  plan: FilePlan,
  status: FixResult['status'],
  before: FixMeasurement,
  reason?: string,
): FixResult {
  const result: FixResult = {
    path: plan.path,
    outputPath: status === 'fixed' ? plan.targetPath : plan.path,
    status,
    plan,
    applied: [],
    before,
    warnings: [],
    needsAttention: status === 'failed' || status === 'blocked' || status === 'skipped',
  };
  if (reason !== undefined) result.reason = reason;
  return result;
}

/**
 * What the file was, before anything happened.
 *
 * `check` already measured every file it could decode. One it could not decode
 * has no `ImageInfo` at all, and its plan is `unfixable` and therefore never
 * executed, so the only thing a report can say about it is its name and the
 * format its extension claims.
 */
function measurementOf(plan: FilePlan, before: FileResult | undefined): FixMeasurement {
  const image = before?.image;
  if (image !== undefined) {
    return { bytes: image.bytes, width: image.width, height: image.height, format: image.format };
  }
  return { bytes: 0, width: 0, height: 0, format: formatFromExtension(plan.path) };
}

function formatFromExtension(relativePath: string): ImageFormat {
  const cut = relativePath.lastIndexOf('.');
  const extension = cut === -1 ? '' : relativePath.slice(cut).toLowerCase();
  return EXTENSION_FORMATS[extension] ?? 'jpeg';
}

/**
 * The source `ImageInfo` the pipeline needs.
 *
 * Only reachable for a plan carrying an encode, and `planFile()` returns
 * `unfixable` for any file `check` could not decode, so the image is always
 * present here. The throw is caught by the caller and reported as a failure,
 * rather than crashing the run, if that ever stops being true.
 */
function requireImage(before: FileResult | undefined, plan: FilePlan): ImageInfo {
  if (before?.image === undefined) {
    throw new Error(`no inspection result for ${plan.path}, so it cannot be re-encoded`);
  }
  return before.image;
}

function operationOf<K extends PlannedOperation['op']>(
  plan: FilePlan,
  op: K,
): Extract<PlannedOperation, { op: K }> | undefined {
  return plan.operations.find((candidate): candidate is Extract<PlannedOperation, { op: K }> =>
    candidate.op === op,
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
