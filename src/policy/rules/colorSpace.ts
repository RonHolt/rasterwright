import type { Finding } from '../../types.js';
import { info, type RuleContext, sourceOf } from './types.js';

/**
 * `colorSpace: srgb`.
 *
 * Three-valued, on purpose (see `scanner/inspect.ts#classifyColorSpace`):
 *
 *   - 'non-srgb' is an ERROR. The pixels will be interpreted wrongly by
 *     anything that ignores the profile, which on the web is most things.
 *   - 'srgb' is compliant, and stays compliant whether the sRGB-ness comes
 *     from an embedded profile or from the untagged-means-sRGB convention.
 *     An image carrying an explicit `sRGB IEC61966-2.1` or `GIMP built-in sRGB`
 *     profile is doing what was asked and is not reported at all.
 *   - 'unknown' is INFO. Not an error, and not silently counted as compliant
 *     either. A false positive here would train people to ignore the tool.
 *
 * The eventual fix order is: decode the source colours correctly, convert
 * pixels to sRGB if required, encode, then decide what profile to retain. None
 * of that is implemented, and `check` rewrites nothing.
 */
export function checkColorSpace(ctx: RuleContext): Finding[] {
  const { info: image, body } = ctx;
  if (body.colorSpace !== 'srgb') return [];

  if (image.colorSpaceStatus === 'srgb') return [];

  if (image.colorSpaceStatus === 'unknown') {
    return [
      info(
        ctx,
        'colorSpaceUnknown',
        'carries an ICC profile Rasterwright could not identify, so sRGB compliance is unknown',
        sourceOf(ctx, 'colorSpace'),
      ),
    ];
  }

  const described = image.iccDescription ?? image.pixelColorSpace;
  return [
    {
      path: image.path,
      rule: sourceOf(ctx, 'colorSpace'),
      check: 'colorSpace',
      severity: 'error',
      actual: described,
      allowed: 'sRGB',
      fixable: 'yes',
      message: `colour space is ${described}, policy requires sRGB`,
    },
  ];
}
