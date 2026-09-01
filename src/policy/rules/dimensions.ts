import type { Finding } from '../../types.js';
import { type RuleContext, sourceOf } from './types.js';

/**
 * `maxWidth` / `maxHeight`. Errors: these are the constraints the repository
 * contract is actually about.
 *
 * Compared against the *displayed* dimensions, i.e. after the EXIF orientation
 * flag is applied, because that is the size the image occupies on a page.
 * Always fixable: downscaling is deterministic.
 */
export function checkDimensions(ctx: RuleContext): Finding[] {
  const findings: Finding[] = [];
  const { info, body } = ctx;

  if (body.maxWidth !== undefined && info.width > body.maxWidth) {
    findings.push({
      path: info.path,
      rule: sourceOf(ctx, 'maxWidth'),
      check: 'maxWidth',
      severity: 'error',
      actual: info.width,
      allowed: body.maxWidth,
      fixable: 'yes',
      message: `${info.width} px wide, allowed ${body.maxWidth} px`,
    });
  }

  if (body.maxHeight !== undefined && info.height > body.maxHeight) {
    findings.push({
      path: info.path,
      rule: sourceOf(ctx, 'maxHeight'),
      check: 'maxHeight',
      severity: 'error',
      actual: info.height,
      allowed: body.maxHeight,
      fixable: 'yes',
      message: `${info.height} px tall, allowed ${body.maxHeight} px`,
    });
  }

  return findings;
}
