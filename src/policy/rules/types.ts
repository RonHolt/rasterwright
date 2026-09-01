import type { EffectiveRule, ImageInfo, Note, RuleBody, Violation } from '../../types.js';

/** Everything a single check is allowed to look at. Pure data in, pure data out. */
export interface RuleContext {
  info: ImageInfo;
  body: RuleBody;
  sources: EffectiveRule['sources'];
  matchedGlobs: string[];
}

export interface RuleOutcome {
  violations: Violation[];
  notes: Note[];
}

export const EMPTY: RuleOutcome = { violations: [], notes: [] };

/** Which rule glob supplied a property's value, for violation attribution. */
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
