import path from 'node:path';

import { FORMAT_EXTENSION } from '../config/resolve.js';
import { DEFAULT_QUALITY } from '../config/schema.js';
import { EXTENSION_FORMATS } from '../policy/rules/extension.js';
import { hasMeaningfulAlpha } from '../policy/rules/types.js';
import { formatBytes } from '../utils/bytes.js';
import type {
  CheckName,
  EffectiveRule,
  EncodeOperation,
  FilePlan,
  FileResult,
  FixPermissions,
  ImageFormat,
  ImageInfo,
  PlannedOperation,
  ResizeOperation,
  RuleBody,
} from '../types.js';

/**
 * Fix planning. Pure.
 *
 * Given what `check` already produced for one file - its `ImageInfo`, its
 * effective policy, its findings - plus the permissions this run was granted,
 * decide what Rasterwright would do about it.
 *
 * This module calls no Sharp, touches no filesystem, and looks at nothing it
 * was not handed. That is deliberate and load-bearing: it means the same inputs
 * always produce the same plan, that a plan can be tested without any image
 * files at all, and that `fix --dry-run` is as safe as `check`.
 *
 * ## Planning is per file, not per finding
 *
 * A file with five findings gets one coherent plan, not five concatenated
 * fragments. An image that is too wide, over budget, in the wrong format and
 * carrying EXIF is resized once, encoded once, and renamed once - not encoded
 * for the budget and then encoded again for the format.
 *
 * ## What planning refuses to claim
 *
 * Nothing here encodes anything, so nothing here predicts an output size. An
 * encode against a byte ceiling is reported as a target plus
 * `outcomeRequiresVerification`, never as an expected result. The honest answer
 * to "will this fit" needs an encoder, and that is execution's job.
 *
 * Purity also bounds what a plan can be trusted to have checked. A file-local
 * planner cannot see the other files in the run or the filesystem, so it cannot
 * detect two plans renaming to the same path, or a rename target that already
 * exists. Those belong to a batch preflight over the whole plan set, which runs
 * after this module and can reject what it produces: see `plan-set.ts` and 04,
 * sections 15.9 and 16. A plan is not executable until preflight has seen it.
 *
 * ## The rule that governs the output, not the input
 *
 * A format conversion moves a file, and the path it moves to can be governed by
 * a different rule. Verification already evaluates the candidate against the
 * *target* path's policy, so a plan built entirely from the source rule would
 * optimize for a ceiling nobody is going to check and miss the one that will be:
 * the search would either chase a budget the target does not have, or report a
 * reachable ceiling as unfixable. `ruleFor` closes that gap. See 04 section 19.12.
 */

export interface PlanOptions {
  /**
   * The effective rule governing an arbitrary repo-relative path.
   *
   * Supplied by the run as `resolver.resolve`, which is a deterministic pure
   * function of the loaded config, so handing it in keeps this module as pure
   * as it was: no filesystem, no Sharp, same inputs and the same plan every
   * time. Omitted, the source rule governs everything, which is right for any
   * plan that does not move the file.
   */
  ruleFor?: (path: string) => EffectiveRule;
}

export function planFile(
  file: FileResult,
  permissions: FixPermissions,
  options: PlanOptions = {},
): FilePlan {
  const warnings = checksOf(file, 'warning');
  const base = {
    path: file.path,
    targetPath: file.path,
    operations: [] as PlannedOperation[],
    blockedOperations: [] as PlannedOperation[],
    resolves: [] as CheckName[],
    unresolved: [] as CheckName[],
    normalizedDuringRewrite: [] as CheckName[],
    warnings,
    requiresVerification: false,
    requiredPermissions: [] as FilePlan['requiredPermissions'],
    reasons: [] as string[],
    notes: [] as string[],
  };

  const errors = file.findings.filter((finding) => finding.severity === 'error');
  const errorChecks = unique(errors.map((finding) => finding.check));

  // Warnings never justify a rewrite. `stripMetadata: true` asks Rasterwright to
  // drop metadata *when it is already rewriting a file*, not to produce a diff
  // on a file nobody said was wrong. So a file with no errors is left alone,
  // and its metadata warnings may persist indefinitely. That is correct.
  if (errors.length === 0) return { ...base, status: 'unchanged' };

  const image = file.image;
  if (image === undefined) {
    return {
      ...base,
      status: 'unfixable',
      unresolved: errorChecks,
      reasons: [file.error ?? 'the image could not be read'],
    };
  }

  // Animation is out of scope for v0 entirely. Note that this is checked before
  // fixability: a resize is "fixable" in the abstract, and running it over an
  // animated file would silently throw away every frame but the first.
  if (image.isAnimated) {
    return {
      ...base,
      status: 'unsupported',
      unresolved: errorChecks,
      reasons: ['v0 does not transform animated images'],
    };
  }

  const blocked = errors.filter((finding) => finding.fixable === 'no');
  if (blocked.length > 0) {
    return {
      ...base,
      status: 'unfixable',
      unresolved: errorChecks,
      reasons: blocked.map((finding) => finding.message),
    };
  }

  const body = file.policy ?? {};
  const has = (check: CheckName): boolean => errorChecks.includes(check);
  const operations: PlannedOperation[] = [];

  // The output format, and therefore the output path, come from the source
  // rule: that is the rule that says what this file must become. Everything the
  // *output* has to satisfy comes from wherever the output lands, which is what
  // `destination` resolves. Both are needed before any operation is built,
  // because the size limits are among the things that move.
  const targetFormat = body.format ?? image.format;
  const convertsFormat = image.format !== targetFormat;
  const targetPath = pathForFormat(file.path, targetFormat);
  const destination = destinationFor(body, targetPath !== file.path, options.ruleFor?.(targetPath));

  // 1. Orientation first: it changes the dimensions everything else works from.
  if (has('orientation')) {
    operations.push({
      op: 'autoOrient',
      orientation: image.orientation,
      from: { width: image.storedWidth, height: image.storedHeight },
      to: { width: image.width, height: image.height },
    });
  }

  // 2. Geometry. Down only, and rounded down, so the result cannot land over a
  //    limit and give the next run something to do. The limits are the tighter
  //    of where the file is and where it is going, so the output is compliant
  //    under both and the source's own violation is still resolved.
  //
  //    A limit that only the *destination* imposes rides along with a rewrite
  //    that is already happening; it never causes one. A rename that touches no
  //    pixels must stay that way: re-encoding a file to satisfy a limit it is
  //    only about to inherit would spend generation loss on a filename change,
  //    and on a 16-bit source it would turn the one plan that works into an
  //    unsupported one, leaving the file permanently mis-named with no remedy.
  const limits = tighterLimits(body, destination.body);
  const resizesForSource = has('maxWidth') || has('maxHeight');
  const rewritesAnyway = resizesForSource || has('orientation') || has('colorSpace') ||
    convertsFormat || has('maxBytes');
  if (resizesForSource || (rewritesAnyway && exceeds(image, limits))) {
    operations.push(resize(image, limits));
  }

  // 3. Colour. After geometry, before the encoder.
  if (has('colorSpace')) {
    operations.push({ op: 'toColorSpace', space: 'srgb', from: image.iccDescription ?? image.pixelColorSpace });
  }

  // 4. Output. A file is written at most once, so every pixel-level reason to
  //    rewrite it collapses into this single encode.
  const rewrites = operations.length > 0 || convertsFormat || has('maxBytes');
  // Under `autoOrient: false` the orientation flag is policy, not a defect, and
  // no `autoOrient` operation is planned. But an encoder drops metadata by
  // default, so a rewrite some *other* error demanded would clear the flag while
  // leaving the pixels unrotated, and the image would display rotated. That is
  // silent data damage on a file the user explicitly asked to be left alone, so
  // the encode carries the flag through instead.
  const preservesOrientation = image.orientation !== 1 && !has('orientation');
  const encoding = rewrites
    ? encode(image, body, destination.body, targetFormat, has('maxBytes'), preservesOrientation)
    : undefined;

  // Sharp's encoders write 8 bits per channel, so re-encoding a 16-bit source
  // halves its precision without saying so. A file whose whole point is the
  // extra depth is not something to silently flatten in pursuit of a width
  // limit, and there is no lossless way to honour both. Checked here rather
  // than earlier because a rename-only plan touches no pixels and is fine.
  if (encoding !== undefined && image.bitDepth !== 8) {
    return {
      ...base,
      status: 'unsupported',
      unresolved: errorChecks,
      reasons: [`${image.bitDepth}-bit source; v0 encodes 8-bit only`],
    };
  }

  if (encoding !== undefined) operations.push(encoding);

  // 5. Filename last, so no output has to be reopened under a new name.
  const rename: PlannedOperation | undefined =
    targetPath === file.path
      ? undefined
      : {
          op: 'rename',
          from: file.path,
          to: targetPath,
          reason: convertsFormat ? 'format-conversion' : 'extension-correction',
          reencode: rewrites,
        };

  // A blocked rename blocks the whole file. Resizing a file we are about to
  // leave deliberately mis-named would spend a lossy re-encode the authorized
  // run has to spend again, and would end the run having knowingly produced a
  // file that is still invalid.
  if (rename !== undefined && !permissions.allowRenames) {
    return {
      ...base,
      status: 'requires-permission',
      targetPath,
      blockedOperations: [...operations, rename],
      unresolved: errorChecks,
      requiredPermissions: ['allowRenames'],
      reasons: [
        rename.reason === 'format-conversion'
          ? `converting to ${targetFormat} renames this file, which can break references to it`
          : 'correcting the extension renames this file, which can break references to it',
      ],
    };
  }
  if (rename !== undefined) operations.push(rename);

  return {
    ...base,
    status: 'planned',
    targetPath,
    operations,
    resolves: errorChecks,
    normalizedDuringRewrite:
      encoding !== undefined && encoding.stripMetadata && warnings.includes('metadata') ? ['metadata'] : [],
    requiresVerification: encoding?.outcomeRequiresVerification ?? false,
    notes: notesFor(file, image, encoding, rename !== undefined, destination, limits, body),
  };
}

/**
 * The policy the *output* has to satisfy.
 *
 * A file that stays where it is answers to the rule it already matched. A file
 * a format conversion moves answers to whatever governs the path it moves to,
 * which is exactly what `verifyCandidate` evaluates it against. Getting this
 * wrong is not a cosmetic mismatch: the byte-budget search would optimize
 * against a ceiling nobody checks and either miss a reachable one or chase a
 * ceiling that does not apply.
 *
 * A target path that matches no rule is ungoverned, and an ungoverned file has
 * no ceiling at all - not the source's, which stopped applying the moment the
 * file left it. The plan says so rather than quietly carrying the old number.
 */
interface Destination {
  /** What the output must satisfy. The source body when nothing moves. */
  body: RuleBody;
  /** True when the output is governed by a different path's rules. */
  moved: boolean;
  /** True when at least one rule glob matches the output path. */
  governed: boolean;
  /** The glob that supplied the output's `maxBytes`, for the note that names it. */
  ceilingGlob: string | undefined;
}

function destinationFor(
  body: RuleBody,
  moves: boolean,
  target: EffectiveRule | undefined,
): Destination {
  if (!moves || target === undefined) {
    return { body, moved: false, governed: true, ceilingGlob: undefined };
  }
  const governed = target.matchedGlobs.length > 0;
  return {
    body: governed ? target.body : {},
    moved: true,
    governed,
    ceilingGlob: governed ? target.sources.maxBytes : undefined,
  };
}

/** The stricter of two optional limits, or whichever one exists. */
function tighter(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Size limits the output must satisfy at both ends of a move. */
function tighterLimits(source: RuleBody, destination: RuleBody): RuleBody {
  const limits: RuleBody = {};
  const width = tighter(source.maxWidth, destination.maxWidth);
  const height = tighter(source.maxHeight, destination.maxHeight);
  if (width !== undefined) limits.maxWidth = width;
  if (height !== undefined) limits.maxHeight = height;
  return limits;
}

/** Whether the image is over either limit, in displayed dimensions. */
function exceeds(image: ImageInfo, limits: RuleBody): boolean {
  return (
    (limits.maxWidth !== undefined && image.width > limits.maxWidth) ||
    (limits.maxHeight !== undefined && image.height > limits.maxHeight)
  );
}

/**
 * Downscale to fit inside the policy's limits.
 *
 * `to` is a *prediction*, not an instruction. The pipeline hands libvips the
 * policy's own limits and `fit: 'inside'` and lets it derive the output, so the
 * rounding here has to be the rounding libvips does or the dry run states
 * dimensions the file never gets. It rounds to nearest, half up, which
 * reproduced sharp 0.35.4 exactly on 220 random source/limit pairs.
 *
 * Rounding to nearest cannot put the output over a limit, which is what the
 * flooring this replaced was defending against. The axis the ratio came from
 * lands on its limit exactly. The other one is strictly below a limit that is
 * itself an integer, so rounding it up can at most reach that integer.
 *
 * Flooring both axes was wrong for a subtler reason than being a pixel short:
 * it was applied to a box that was then handed to `fit: 'inside'`, which
 * derives its own scale from whatever box it is given. A floored box is a
 * slightly different shape from the source, so libvips shrank the other axis
 * again to fit it - 2399x938 under `maxWidth: 1600` was planned as 1600x625
 * and written as 1598x625.
 */
function resize(image: ImageInfo, body: RuleBody): ResizeOperation {
  const ratio = Math.min(
    body.maxWidth === undefined ? 1 : body.maxWidth / image.width,
    body.maxHeight === undefined ? 1 : body.maxHeight / image.height,
    1,
  );

  const operation: ResizeOperation = {
    op: 'resize',
    from: { width: image.width, height: image.height },
    to: {
      width: Math.max(1, Math.round(image.width * ratio)),
      height: Math.max(1, Math.round(image.height * ratio)),
    },
    fit: 'inside',
    upscale: false,
  };
  if (body.maxWidth !== undefined) operation.maxWidth = body.maxWidth;
  if (body.maxHeight !== undefined) operation.maxHeight = body.maxHeight;
  return operation;
}

/** Formats with a quality dial. PNG is lossless and has none. */
const LOSSY: ReadonlySet<ImageFormat> = new Set<ImageFormat>(['jpeg', 'webp']);

/**
 * The single encode.
 *
 * `body` is the source rule and decides *how* to write the file: the format,
 * whether metadata is dropped, whether the orientation flag is carried through.
 * `destination` is the rule governing the output path and decides *what the
 * output must satisfy*: the byte ceiling, and the quality band the search runs
 * over to meet it. They are the same object unless a conversion moves the file.
 */
function encode(
  image: ImageInfo,
  body: RuleBody,
  destination: RuleBody,
  format: ImageFormat,
  budgetDriven: boolean,
  preservesOrientation: boolean,
): EncodeOperation {
  const operation: EncodeOperation = {
    op: 'encode',
    format,
    budgetDriven,
    preservesOrientation,
    stripMetadata: body.stripMetadata === true,
    preserveAlpha: hasMeaningfulAlpha(image),
    // Generation loss: pixels that have already been through a lossy encoder
    // are being put through one again. Allowed, because an error-level finding
    // demanded the rewrite, but never presented as a free saving.
    lossyReencode: LOSSY.has(image.format) && LOSSY.has(format),
    // A byte ceiling is the only thing planning cannot answer, because
    // answering it means encoding.
    outcomeRequiresVerification: destination.maxBytes !== undefined,
  };
  if (destination.maxBytes !== undefined) operation.maxBytes = destination.maxBytes;
  if (LOSSY.has(format)) operation.quality = destination.quality ?? { ...DEFAULT_QUALITY };
  return operation;
}

/**
 * Where a file has to live once its bytes are in `format`.
 *
 * Returns the path unchanged when the current extension already denotes the
 * target format, so `photo.jpeg` is never renamed to `photo.jpg` for tidiness.
 * Only a genuinely wrong extension moves a file.
 */
function pathForFormat(filePath: string, format: ImageFormat): string {
  const extension = path.posix.extname(filePath);
  if (EXTENSION_FORMATS[extension.toLowerCase()] === format) return filePath;
  return `${filePath.slice(0, filePath.length - extension.length)}.${FORMAT_EXTENSION[format]}`;
}

/** Caveats about a plan that is complete but worth reading twice. */
function notesFor(
  file: FileResult,
  image: ImageInfo,
  encoding: EncodeOperation | undefined,
  renames: boolean,
  destination: Destination,
  limits: RuleBody,
  body: RuleBody,
): string[] {
  const notes: string[] = [];

  // The rename moves the file under different policy, and the numbers the
  // encode has to hit came from there rather than from the rule the user was
  // looking at. Saying which glob supplied them is the difference between a
  // ceiling that looks wrong and one that is explicable.
  if (destination.moved && encoding !== undefined) {
    if (!destination.governed) {
      notes.push(
        'after the rename this file matches no rule, so no byte ceiling applies to the encode',
      );
    } else if (destination.body.maxBytes !== body.maxBytes) {
      const glob = destination.ceilingGlob ?? 'the target rule';
      notes.push(
        destination.body.maxBytes === undefined
          ? `after the rename this file is governed by ${glob}, which sets no maxBytes, so no ceiling applies`
          : `the ${formatBytes(destination.body.maxBytes)} ceiling comes from ${glob}, which governs the ` +
            'file after the rename, not from the rule matching it now',
      );
    }
  }

  // A limit the file is not currently breaking, imposed by where it is going.
  // Without this the resize would look unmotivated in the report.
  if (
    destination.moved &&
    destination.governed &&
    renames &&
    encoding !== undefined &&
    tighterThanSource(limits, body)
  ) {
    notes.push(
      'the resize target comes from the rule governing the file after the rename, which is ' +
        'stricter than the one matching it now',
    );
  }

  // Preserving the flag means writing a minimal EXIF block into a file that may
  // have had none. That is a visible consequence of a rewrite the user did not
  // ask for, so the plan says it out loud rather than letting it turn up as a
  // surprise in the next `check`.
  if (encoding?.preservesOrientation === true) {
    notes.push(
      `autoOrient is off, so EXIF orientation ${image.orientation} is preserved through the rewrite ` +
        'and a minimal EXIF block remains; later checks report that as a metadata warning',
    );
  }

  // PNG has no quality dial. Lossless re-encoding at maximum effort buys a few
  // percent and nothing more, and palette quantization is deliberately not in
  // v0 because it destroys photographs. Say so now rather than failing later
  // with no explanation.
  const newCeiling = encoding?.maxBytes !== undefined && (encoding.budgetDriven || destination.moved);
  if (encoding?.format === 'png' && newCeiling) {
    notes.push(
      'PNG is lossless, so the only lever is a maximum-effort re-encode; the ceiling may be unreachable',
    );
  }

  // A conversion whose output no longer matches any rule silently leaves policy.
  // `check` reports this; a plan that is about to cause it should repeat it.
  if (renames && file.findings.some((finding) => finding.check === 'ruleGlobExcludesTargetFormat')) {
    notes.push('after the rename this file would no longer match any rule in the policy');
  }

  return notes;
}

/** True when the merged limits are stricter than the source rule's own. */
function tighterThanSource(limits: RuleBody, source: RuleBody): boolean {
  return (
    (limits.maxWidth !== undefined && limits.maxWidth !== source.maxWidth) ||
    (limits.maxHeight !== undefined && limits.maxHeight !== source.maxHeight)
  );
}

function checksOf(file: FileResult, severity: 'error' | 'warning'): CheckName[] {
  return unique(file.findings.filter((finding) => finding.severity === severity).map((finding) => finding.check));
}

function unique(checks: readonly CheckName[]): CheckName[] {
  return [...new Set(checks)];
}
