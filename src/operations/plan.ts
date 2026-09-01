import path from 'node:path';

import { FORMAT_EXTENSION } from '../config/resolve.js';
import { DEFAULT_QUALITY } from '../config/schema.js';
import { EXTENSION_FORMATS } from '../policy/rules/extension.js';
import { hasMeaningfulAlpha } from '../policy/rules/types.js';
import type {
  CheckName,
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
 * exists. Those belong to a batch preflight over the whole plan set, which does
 * not exist yet (04, section 15.9).
 */

export function planFile(file: FileResult, permissions: FixPermissions): FilePlan {
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
  //    limit and give the next run something to do.
  if (has('maxWidth') || has('maxHeight')) operations.push(resize(image, body));

  // 3. Colour. After geometry, before the encoder.
  if (has('colorSpace')) {
    operations.push({ op: 'toColorSpace', space: 'srgb', from: image.iccDescription ?? image.pixelColorSpace });
  }

  // 4. Output. A file is written at most once, so every pixel-level reason to
  //    rewrite it collapses into this single encode.
  const targetFormat = body.format ?? image.format;
  const convertsFormat = image.format !== targetFormat;
  const rewrites = operations.length > 0 || convertsFormat || has('maxBytes');
  const encoding = rewrites ? encode(image, body, targetFormat, has('maxBytes')) : undefined;
  if (encoding !== undefined) operations.push(encoding);

  // 5. Filename last, so no output has to be reopened under a new name.
  const targetPath = pathForFormat(file.path, targetFormat);
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
    notes: notesFor(file, encoding, rename !== undefined),
  };
}

/**
 * Downscale to fit inside the policy's limits.
 *
 * Both dimensions are floored. Rounding up, or rounding to nearest, can put the
 * output a pixel over `maxWidth`, which would make `fix` non-idempotent: the
 * second run would find the same violation and resize again. Losing at most one
 * pixel is the cheap side of that trade.
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
      width: Math.max(1, Math.floor(image.width * ratio)),
      height: Math.max(1, Math.floor(image.height * ratio)),
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

function encode(
  image: ImageInfo,
  body: RuleBody,
  format: ImageFormat,
  budgetDriven: boolean,
): EncodeOperation {
  const operation: EncodeOperation = {
    op: 'encode',
    format,
    budgetDriven,
    stripMetadata: body.stripMetadata === true,
    preserveAlpha: hasMeaningfulAlpha(image),
    // Generation loss: pixels that have already been through a lossy encoder
    // are being put through one again. Allowed, because an error-level finding
    // demanded the rewrite, but never presented as a free saving.
    lossyReencode: LOSSY.has(image.format) && LOSSY.has(format),
    // A byte ceiling is the only thing planning cannot answer, because
    // answering it means encoding.
    outcomeRequiresVerification: body.maxBytes !== undefined,
  };
  if (body.maxBytes !== undefined) operation.maxBytes = body.maxBytes;
  if (LOSSY.has(format)) operation.quality = body.quality ?? { ...DEFAULT_QUALITY };
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
function notesFor(file: FileResult, encoding: EncodeOperation | undefined, renames: boolean): string[] {
  const notes: string[] = [];

  // PNG has no quality dial. Lossless re-encoding at maximum effort buys a few
  // percent and nothing more, and palette quantization is deliberately not in
  // v0 because it destroys photographs. Say so now rather than failing later
  // with no explanation.
  if (encoding?.format === 'png' && encoding.budgetDriven) {
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

function checksOf(file: FileResult, severity: 'error' | 'warning'): CheckName[] {
  return unique(file.findings.filter((finding) => finding.severity === severity).map((finding) => finding.check));
}

function unique(checks: readonly CheckName[]): CheckName[] {
  return [...new Set(checks)];
}
