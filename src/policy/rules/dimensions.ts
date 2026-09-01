import type { Violation } from '../../types.js';
import { type RuleContext, type RuleOutcome, sourceOf } from './types.js';

/**
 * `maxWidth` / `maxHeight`.
 *
 * Compared against the *displayed* dimensions, i.e. after the EXIF orientation
 * flag is applied, because that is the size the image occupies on a page.
 * Always fixable: downscaling is deterministic and lossless in the sense that
 * matters here.
 */
export function checkDimensions(ctx: RuleContext): RuleOutcome {
  const violations: Violation[] = [];
  const { info, body } = ctx;

  if (body.maxWidth !== undefined && info.width > body.maxWidth) {
    violations.push({
      path: info.path,
      rule: sourceOf(ctx, 'maxWidth'),
      check: 'maxWidth',
      actual: info.width,
      allowed: body.maxWidth,
      fixable: 'yes',
      message: `${info.width} px wide, allowed ${body.maxWidth} px`,
    });
  }

  if (body.maxHeight !== undefined && info.height > body.maxHeight) {
    violations.push({
      path: info.path,
      rule: sourceOf(ctx, 'maxHeight'),
      check: 'maxHeight',
      actual: info.height,
      allowed: body.maxHeight,
      fixable: 'yes',
      message: `${info.height} px tall, allowed ${body.maxHeight} px`,
    });
  }

  return { violations, notes: [] };
}
