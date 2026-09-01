import type { EffectiveRule, Finding, ImageInfo, RuleBody } from '../../types.js';

/** Everything a single check is allowed to look at. Pure data in, pure data out. */
export interface RuleContext {
  info: ImageInfo;
  body: RuleBody;
  sources: EffectiveRule['sources'];
  matchedGlobs: string[];
}

/** Which rule glob supplied a property's value, for finding attribution. */
export function sourceOf(ctx: RuleContext, key: keyof RuleBody): string {
  return ctx.sources[key] ?? '(defaults)';
}

/**
 * Does this image have transparency that actually matters?
 *
 * An alpha channel whose every pixel is opaque carries no information. When
 * opacity could not be determined we assume it matters, because the failure
 * mode of guessing wrong is a black box where a logo used to be.
 */
export function hasMeaningfulAlpha(info: ImageInfo): boolean {
  return info.hasAlpha && info.isOpaque !== true;
}

/** Display labels for formats. */
export const FORMAT_LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' } as const;

/** Shorthand for an informational finding, which never has anything to fix. */
export function info(
  ctx: RuleContext,
  check: Finding['check'],
  message: string,
  rule = '(built-in)',
): Finding {
  return {
    path: ctx.info.path,
    rule,
    check,
    severity: 'info',
    actual: null,
    allowed: null,
    fixable: 'n/a',
    message,
  };
}
