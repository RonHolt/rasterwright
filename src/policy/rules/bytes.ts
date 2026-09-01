import { formatBytes } from '../../utils/bytes.js';
import type { Violation } from '../../types.js';
import { type RuleContext, type RuleOutcome, sourceOf } from './types.js';

/**
 * `maxBytes`.
 *
 * The configured value is a CEILING, not a target. A file comfortably under
 * budget is compliant and will never be re-encoded to consume the remainder.
 *
 * Fixability is reported as 'unknown'. Whether a given image can be brought
 * under a byte budget depends on what the encoder produces, and `check` is
 * read-only, so it deliberately does not find out. PNG is the honest case:
 * it is lossless, so there may be no way down at all.
 */
export function checkBytes(ctx: RuleContext): RuleOutcome {
  const { info, body } = ctx;
  if (body.maxBytes === undefined || info.bytes <= body.maxBytes) return { violations: [], notes: [] };

  const violation: Violation = {
    path: info.path,
    rule: sourceOf(ctx, 'maxBytes'),
    check: 'maxBytes',
    actual: info.bytes,
    allowed: body.maxBytes,
    fixable: 'unknown',
    message:
      `${formatBytes(info.bytes)}, allowed ${formatBytes(body.maxBytes)}; ` +
      'reaching the budget depends on encoding, which check does not perform',
  };

  return { violations: [violation], notes: [] };
}
