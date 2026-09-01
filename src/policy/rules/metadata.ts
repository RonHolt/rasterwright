import type { Violation } from '../../types.js';
import { type RuleContext, type RuleOutcome, sourceOf } from './types.js';

/**
 * `stripMetadata`.
 *
 * Only reports what Sharp exposes as present: an EXIF block, an XMP packet, or
 * an embedded ICC profile. It deliberately does not claim to know about every
 * ancillary chunk a file may carry - reporting "metadata: yes/no" honestly is
 * more useful than an inventory Rasterwright cannot actually produce.
 */
export function checkMetadata(ctx: RuleContext): RuleOutcome {
  const { info, body } = ctx;
  if (body.stripMetadata !== true) return { violations: [], notes: [] };

  const present: string[] = [];
  if (info.hasExif) present.push('EXIF');
  if (info.hasXmp) present.push('XMP');
  if (info.hasIccProfile) present.push('ICC profile');
  if (present.length === 0) return { violations: [], notes: [] };

  const violation: Violation = {
    path: info.path,
    rule: sourceOf(ctx, 'stripMetadata'),
    check: 'metadata',
    actual: present.join(', '),
    allowed: 'none',
    fixable: 'yes',
    message: `${present.join(', ')} present, policy says strip metadata`,
  };

  return { violations: [violation], notes: [] };
}
