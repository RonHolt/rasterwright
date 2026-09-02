import sharp from 'sharp';
import type { Sharp } from 'sharp';

import { hasMeaningfulAlpha } from '../policy/rules/types.js';

import type {
  EncodeOperation,
  EncodeOutcome,
  FilePlan,
  ImageInfo,
  PlannedOperation,
  QualityBand,
  ResizeOperation,
} from '../types.js';

/**
 * A plan's pixel operations, executed as one Sharp chain into one buffer.
 *
 * No filesystem, no temp files, no policy decisions: bytes in, bytes out. That
 * separation is what lets the candidate be inspected and verified before
 * anything is written, which is the invariant the whole execution layer rests
 * on (04 section 8, and 15.12).
 *
 * ## One chain, one encode
 *
 * The operation order is the planner's and is fixed: autoOrient, resize,
 * colour, encode. Every reason to rewrite a file folds into that single encode.
 * Not resize-then-encode, then re-encode to normalize, then convert format:
 * each extra pass would be another round of generation loss, and the output
 * would depend on how many findings the file happened to have.
 *
 * ## Colour, verified rather than assumed
 *
 * Three cases, and the difference between them is invisible in the metadata
 * tags alone. Stored pixel values were read back with `{ ignoreIcc: true }` to
 * confirm each one:
 *
 *   | plan                     | call                     | pixels        | tag       |
 *   |--------------------------|--------------------------|---------------|-----------|
 *   | has `toColorSpace`       | `withIccProfile('srgb')` | converted     | sRGB      |
 *   | none, source has an ICC  | `keepIccProfile()`       | source space  | source's  |
 *   | none, no ICC             | nothing                  | sRGB          | untagged  |
 *
 * All three are colour-correct. `keepIccProfile()` genuinely preserves the
 * source space end to end, which is what "conservative where no colour policy
 * applies" (04 section 15.10) asks for: discarding a profile changes how every
 * pixel is interpreted, and that is not a normalization.
 *
 * `toColourspace('srgb')` is deliberately never called. It changes libvips'
 * interpretation of the numbers rather than performing the ICC transform, and
 * it is not needed anyway: a plain encode of a CMYK JPEG already emerges sRGB.
 *
 * ## Metadata
 *
 * Sharp strips ancillary metadata by default, so `stripMetadata: true` is the
 * path that calls nothing. `withMetadata()` is never used as a generic "keep":
 * it embeds a 480-byte sRGB ICC profile as a side effect, which silently
 * contradicts both the strip case and the keep-the-source-profile case.
 *
 * ## The byte-budget search
 *
 * When the plan carries a `maxBytes`, the chain above is built once and only
 * the encoder is re-run: encode at `quality.start`, and if those bytes fit,
 * accept them. Otherwise binary-search the integer qualities in
 * `[floor, start - 1]`, keeping the highest one whose *measured* size fits.
 * Never below `floor`, never upward from `start`, and never on a claim about
 * monotonicity: only a probe actually measured under the ceiling is accepted,
 * so a size curve with an inversion in it costs a missed optimization and can
 * never produce a wrong write. See 04 section 19.
 *
 * Nothing here decides that a file is acceptable. When no quality fits, the
 * smallest probe is returned anyway, with the quality that produced it, so the
 * executor's verification refuses it on the evidence and the failure message
 * can say what the best achievable size actually was.
 */

/** The bytes one render produced, and what the encoder did to produce them. */
export interface RenderedCandidate extends EncodeOutcome {
  buffer: Buffer;
}

/**
 * Render the candidate bytes for `plan`.
 *
 * `image` is the source's `ImageInfo`, needed for the orientation flag and for
 * the colour decision. `source` must be the bytes that produced it.
 *
 * Throws rather than guessing when asked to execute something it cannot do: a
 * plan with no encode, a 16-bit source, or transparency bound for a JPEG.
 */
export async function renderCandidate(
  source: Buffer,
  plan: FilePlan,
  image: ImageInfo,
): Promise<RenderedCandidate> {
  const encode = operation(plan, 'encode');
  if (encode === undefined) {
    throw new Error(`plan for ${plan.path} has no encode operation, so there is nothing to render`);
  }

  // Defence in depth against the two ways an encode destroys something that
  // cannot be recovered. The planner already refuses both, and it is the planner
  // that would have to change for either to reach here, so the check lives on
  // the other side of that boundary rather than beside the decision it repeats.
  if (image.bitDepth !== 8) {
    throw new Error(
      `${plan.path} is ${image.bitDepth}-bit and the encoders write 8-bit; ` +
        're-encoding it would silently discard precision',
    );
  }
  if (encode.format === 'jpeg' && (encode.preserveAlpha || hasMeaningfulAlpha(image))) {
    throw new Error(
      `${plan.path} carries transparency and JPEG cannot hold it; ` +
        'encoding would flatten every transparent pixel to black',
    );
  }

  // Built once. Every probe clones it, so the base chain stays immutable and no
  // two encodes can ever share a mutable options object.
  const chain = buildChain(source, plan, encode, image);

  if (encode.format === 'png') {
    // Lossless, maximum effort, exactly once: there is no dial to search. An
    // over-budget result is a real failure and is reported as one, rather than
    // reached for with palette quantization that would silently change pixels.
    const buffer = await chain.clone().png({ compressionLevel: 9, effort: 10, palette: false }).toBuffer();
    return { buffer, format: 'png', bytes: buffer.length };
  }

  const format = encode.format;
  const { buffer, quality } = await searchQuality(
    qualityBand(encode),
    encode.maxBytes,
    async (at) => encodeAt(chain, format, at).toBuffer(),
  );
  return { buffer, format, quality, bytes: buffer.length };
}

/** Attach the lossy encoder for `format` at `quality` to a clone of `chain`. */
function encodeAt(chain: Sharp, format: 'jpeg' | 'webp', quality: number): Sharp {
  return format === 'jpeg'
    ? chain.clone().jpeg({ quality, mozjpeg: true, progressive: true })
    : chain.clone().webp({ quality, effort: 4 });
}

/**
 * The highest quality in `[floor, start]` whose output fits `maxBytes`.
 *
 * Separated from the Sharp chain so the algorithm can be tested against a
 * synthetic size function, including the non-monotone one no real encoder is
 * guaranteed not to be.
 *
 * `maxBytes` undefined means there is no ceiling to search against, so exactly
 * one encode happens, at `start`. That is the path every plan took before this
 * phase existed and it must stay byte-identical.
 *
 * When nothing fits, the smallest measured probe is returned rather than
 * thrown away: it is the evidence the failure message reports, and handing it
 * back keeps the decision to refuse in the executor's verification step where
 * every other refusal lives.
 */
export async function searchQuality(
  band: QualityBand,
  maxBytes: number | undefined,
  encode: (quality: number) => Promise<Buffer>,
): Promise<{ buffer: Buffer; quality: NonNullable<EncodeOutcome['quality']> }> {
  const { start, floor } = band;
  const first = await encode(start);
  let attempts = 1;

  if (maxBytes === undefined || first.length <= maxBytes) {
    return { buffer: first, quality: { start, chosen: start, floor, searched: false, attempts } };
  }

  // Tracked independently of the loop's own bounds. The search happens to probe
  // `floor` last whenever nothing fits, but relying on that would make the
  // failure message a property of the loop shape rather than of what was
  // measured, and a later refactor would quietly break it.
  let smallest = { quality: start, buffer: first };
  let best: { quality: number; buffer: Buffer } | undefined;

  let low = floor;
  let high = start - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const probe = await encode(mid);
    attempts += 1;

    if (probe.length < smallest.buffer.length) smallest = { quality: mid, buffer: probe };

    // Measured, never inferred. A probe is accepted only because its own bytes
    // fit, so the write is correct even where the size curve is not monotone.
    if (probe.length <= maxBytes) {
      if (best === undefined || mid > best.quality) best = { quality: mid, buffer: probe };
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const accepted = best ?? smallest;
  return {
    buffer: accepted.buffer,
    quality: { start, chosen: accepted.quality, floor, searched: attempts > 1, attempts },
  };
}

/** The plan's pixel operations as a configured Sharp chain, with no encoder attached. */
function buildChain(source: Buffer, plan: FilePlan, encode: EncodeOperation, image: ImageInfo): Sharp {
  const autoOrient = operation(plan, 'autoOrient');
  const resize = operation(plan, 'resize');
  const toColorSpace = operation(plan, 'toColorSpace');

  let pipe: Sharp = sharp(source, { failOn: 'error' });

  // First, because it changes the dimensions everything downstream works from.
  if (autoOrient !== undefined) pipe = pipe.autoOrient();

  if (resize !== undefined) {
    const { width, height } = resizeTarget(resize, encode, image);
    pipe = pipe.resize({ width, height, fit: 'inside', withoutEnlargement: true });
  }

  if (toColorSpace !== undefined) pipe = pipe.withIccProfile('srgb');
  else if (image.hasIccProfile) pipe = pipe.keepIccProfile();

  // `keepMetadata()` already carries the orientation flag through, so the
  // explicit call is only needed on the path that strips everything.
  //
  // What makes the flag survive is that `withExif()` is called at all: it turns
  // the encode into one that writes an EXIF block, and Sharp fills the
  // orientation in from the source. The value passed here is *ignored* -
  // passing `'1'` still yields the source's own flag - so this is a request for
  // a minimal EXIF block rather than an assignment. It is written as the source
  // orientation anyway, because a call that reads as a lie is a trap for the
  // next person even when Sharp happens to overrule it.
  if (!encode.stripMetadata) pipe = pipe.keepMetadata();
  else if (encode.preservesOrientation) {
    pipe = pipe.withExif({ IFD0: { Orientation: String(image.orientation) } });
  }

  return pipe;
}

/**
 * The dimensions to hand the resizer.
 *
 * The planner works in *displayed* dimensions, because that is what a browser
 * lays out and therefore what `maxWidth` governs. Sharp resizes the pixels as
 * they are stored. Those agree except in one case: a file whose orientation
 * flag rotates it a quarter turn and which is not being auto-oriented, where
 * the stored image is the displayed one with its axes swapped. Passing the
 * displayed target straight through there would fit the *long* stored edge into
 * the short limit and shrink the image far more than the policy asked for.
 */
function resizeTarget(
  resize: ResizeOperation,
  encode: EncodeOperation,
  image: ImageInfo,
): { width: number; height: number } {
  const swapped = encode.preservesOrientation && QUARTER_TURN.has(image.orientation);
  return swapped
    ? { width: resize.to.height, height: resize.to.width }
    : { width: resize.to.width, height: resize.to.height };
}

/** EXIF orientations whose stored and displayed axes are swapped. */
const QUARTER_TURN: ReadonlySet<number> = new Set([5, 6, 7, 8]);

/**
 * The band the search runs over.
 *
 * `start` is the maximum, never a value inferred from the source. Rasterwright
 * does not try to detect what quality a JPEG was originally encoded at: the
 * signals are indirect, per-encoder, and wrong often enough that acting on them
 * would put a heuristic underneath every output byte (04 section 15.11).
 */
function qualityBand(encode: EncodeOperation): QualityBand {
  if (encode.quality === undefined) {
    throw new Error(`no quality band for a ${encode.format} encode, which needs one`);
  }
  return encode.quality;
}

/** The plan's operation of a given kind, or undefined. There is at most one of each. */
function operation<K extends PlannedOperation['op']>(
  plan: FilePlan,
  op: K,
): Extract<PlannedOperation, { op: K }> | undefined {
  return plan.operations.find((candidate): candidate is Extract<PlannedOperation, { op: K }> =>
    candidate.op === op,
  );
}
