import { formatBytes } from '../../utils/bytes.js';
import type { Finding } from '../../types.js';
import { type RuleContext, sourceOf } from './types.js';

/**
 * `maxBytes`. An error: a file over its ceiling is a genuine constraint breach.
 *
 * The configured value is a CEILING, not a target. A file comfortably under
 * budget is compliant and will never be re-encoded to consume the remainder.
 *
 * Fixability is 'unknown'. Whether a given image can be brought under a byte
 * budget depends on what the encoder produces, and `check` does not encode -
 * that boundary is what keeps `check` read-only and fast. PNG is the honest
 * case: it is lossless, so there may be no way down at all.
 */
export function checkBytes(ctx: RuleContext): Finding[] {
  const { info, body } = ctx;
  if (body.maxBytes === undefined || info.bytes <= body.maxBytes) return [];

  return [
    {
      path: info.path,
      rule: sourceOf(ctx, 'maxBytes'),
      check: 'maxBytes',
      severity: 'error',
      actual: info.bytes,
      allowed: body.maxBytes,
      fixable: 'unknown',
      message: `${formatBytes(info.bytes)}, allowed ${formatBytes(body.maxBytes)}`,
    },
  ];
}
