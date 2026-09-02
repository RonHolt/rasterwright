import type { Finding } from '../../types.js';
import { type RuleContext, sourceOf } from './types.js';

/**
 * EXIF orientation, gated on `autoOrient` (default true).
 *
 * A non-normal orientation flag means the stored pixels and the displayed image
 * disagree, which every downstream tool then has to handle correctly - and many
 * do not. With `autoOrient: true` that is an error a fix normalizes
 * by rotating the pixels and clearing the flag.
 *
 * With `autoOrient: false` Rasterwright leaves orientation alone entirely and
 * reports nothing about it, for projects that have a reason to keep the flag.
 */
export function checkOrientation(ctx: RuleContext): Finding[] {
  const { info, body } = ctx;
  if (body.autoOrient === false) return [];
  if (info.orientation === 1) return [];

  return [
    {
      path: info.path,
      rule: sourceOf(ctx, 'autoOrient'),
      check: 'orientation',
      severity: 'error',
      actual: info.orientation,
      allowed: 1,
      fixable: info.isAnimated ? 'no' : 'yes',
      message:
        `EXIF orientation ${info.orientation}; stored as ${info.storedWidth}x${info.storedHeight}, ` +
        `displayed as ${info.width}x${info.height}`,
    },
  ];
}
