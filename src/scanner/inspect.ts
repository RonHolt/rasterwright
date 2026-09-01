import fs from 'node:fs/promises';
import sharp from 'sharp';
import type { Metadata } from 'sharp';

import { sha256 } from '../utils/hash.js';
import { readIccSummary, looksLikeSrgb } from '../utils/icc.js';
import { toAbsolute } from '../utils/paths.js';
import type { ColorSpaceStatus, ImageFormat, ImageInfo } from '../types.js';

/**
 * The only place in the read path that touches Sharp.
 *
 * Strictly read-only: it opens files, decodes headers, and (only when an alpha
 * channel exists) asks libvips for channel statistics. Nothing is written.
 */

export type InspectResult =
  | { ok: true; info: ImageInfo }
  | { ok: false; path: string; error: string };

const KNOWN_FORMATS = new Set<string>(['jpeg', 'png', 'webp']);

/** Sharp version strings, recorded so a surprising result is explainable later. */
export function engineVersions(): { sharp: string; vips: string } {
  return { sharp: sharp.versions.sharp, vips: sharp.versions.vips };
}

export async function inspect(root: string, relativePath: string): Promise<InspectResult> {
  const absolute = toAbsolute(root, relativePath);

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(absolute);
  } catch (error) {
    return { ok: false, path: relativePath, error: `could not read file: ${(error as Error).message}` };
  }

  let metadata: Metadata;
  try {
    metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  } catch (error) {
    return { ok: false, path: relativePath, error: `could not decode image: ${(error as Error).message}` };
  }

  const format = metadata.format;
  if (format === undefined || !KNOWN_FORMATS.has(format)) {
    return {
      ok: false,
      path: relativePath,
      error: `unsupported image format${format === undefined ? '' : ` '${format}'`} for this extension`,
    };
  }

  const storedWidth = metadata.width;
  const storedHeight = metadata.height;
  if (storedWidth === undefined || storedHeight === undefined) {
    return { ok: false, path: relativePath, error: 'could not determine image dimensions' };
  }

  // `metadata.width` is the *stored* width. For EXIF orientations 5-8 the
  // displayed image is rotated, and the displayed size is what a browser lays
  // out and therefore what maxWidth/maxHeight must govern.
  const displayed = metadata.autoOrient ?? { width: storedWidth, height: storedHeight };

  const hasAlpha = metadata.hasAlpha === true;
  const icc = metadata.icc;
  const iccSummary = icc === undefined ? undefined : readIccSummary(icc);

  // `stats()` decodes every pixel, so only pay for it when there is an alpha
  // channel whose actual use we need to know about.
  let isOpaque: boolean | null = null;
  if (hasAlpha) {
    try {
      isOpaque = (await sharp(buffer, { failOn: 'error' }).stats()).isOpaque;
    } catch {
      // Leave null. Callers treat "not determined" as "assume transparent",
      // which is the conservative direction.
      isOpaque = null;
    }
  }

  const pixelColorSpace = metadata.space ?? 'unknown';

  const info: ImageInfo = {
    path: relativePath,
    bytes: buffer.byteLength,
    format: format as ImageFormat,
    width: displayed.width,
    height: displayed.height,
    storedWidth,
    storedHeight,
    hasAlpha,
    isOpaque,
    pixelColorSpace,
    colorSpaceStatus: classifyColorSpace(pixelColorSpace, iccSummary),
    hasIccProfile: icc !== undefined,
    iccDescription: iccSummary?.description ?? null,
    hasExif: metadata.exif !== undefined,
    hasXmp: metadata.xmp !== undefined,
    hasIptc: metadata.iptc !== undefined,
    // Photoshop's TIFF tag and PNG text chunks. Ancillary, but neither EXIF nor
    // XMP, so they get their own bucket rather than being lumped in or ignored.
    // Rarely populated in practice: this Sharp build decodes PNG with libspng,
    // which does not surface tEXt chunks, so a PNG carrying one reads as clean.
    // Reported when Sharp does expose it; never inferred.
    hasOtherMetadata:
      metadata.tifftagPhotoshop !== undefined ||
      (metadata.comments !== undefined && metadata.comments.length > 0),
    orientation: metadata.orientation ?? 1,
    isAnimated: (metadata.pages ?? 1) > 1,
    contentHash: sha256(buffer),
  };

  return { ok: true, info };
}

/**
 * Decide how confident we are about an image's colour space.
 *
 * Deliberately three-valued. Sharp reports libvips' pixel interpretation, which
 * answers "what are these numbers" but not "what do they mean" - only the ICC
 * profile answers that, and Rasterwright only parses the profile's description
 * tag. So:
 *
 *   - CMYK pixels, or a CMYK profile      -> non-srgb, confidently
 *   - a profile whose description says sRGB -> srgb, confidently
 *   - a profile that names something else -> non-srgb, confidently
 *   - a profile we could not read         -> unknown (never a violation)
 *   - no profile at all                   -> srgb, by the web's convention that
 *                                            untagged RGB is sRGB
 */
export function classifyColorSpace(
  pixelColorSpace: string,
  icc: { description: string | undefined; dataColorSpace: string | undefined } | undefined,
): ColorSpaceStatus {
  if (pixelColorSpace.startsWith('cmyk')) return 'non-srgb';
  if (icc === undefined) return 'srgb';
  if (icc.dataColorSpace === 'CMYK') return 'non-srgb';
  if (icc.description === undefined) return 'unknown';
  return looksLikeSrgb(icc) ? 'srgb' : 'non-srgb';
}
