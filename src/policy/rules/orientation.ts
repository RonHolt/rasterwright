import type { Violation } from '../../types.js';
import type { RuleContext, RuleOutcome } from './types.js';

/**
 * EXIF orientation.
 *
 * A non-normal orientation flag means the stored pixels and the displayed image
 * disagree, which every downstream tool then has to handle. Rasterwright always
 * wants it normalized, so this check has no config key in v0 - it applies to
 * every governed file. If that turns out to be wrong, an `autoOrient` property
 * is the obvious escape hatch, but speculative config is worse than none.
 */
export function checkOrientation(ctx: RuleContext): RuleOutcome {
  const { info } = ctx;
  if (info.orientation === 1) return { violations: [], notes: [] };

  const violation: Violation = {
    path: info.path,
    rule: '(built-in)',
    check: 'orientation',
    actual: info.orientation,
    allowed: 1,
    fixable: info.isAnimated ? 'no' : 'yes',
    message:
      `EXIF orientation ${info.orientation}; stored as ${info.storedWidth}x${info.storedHeight}, ` +
      `displayed as ${info.width}x${info.height}`,
  };

  return { violations: [violation], notes: [] };
}
