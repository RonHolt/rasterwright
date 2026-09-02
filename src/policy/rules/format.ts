import { globCoversTargetFormat } from '../../config/resolve.js';
import type { Finding } from '../../types.js';
import { FORMAT_LABEL, hasMeaningfulAlpha, info, type RuleContext, sourceOf } from './types.js';

/**
 * `format`. An error: policy named an output format and the file is not it.
 *
 * Whether it is *safely* fixable is a separate question:
 *
 *   - JPEG cannot represent transparency. An image with meaningful alpha under
 *     a `format: jpeg` rule is not fixable. Rasterwright will not guess a
 *     background colour, and `check` never flattens anything.
 *   - Animated images are out of scope for v0.
 *
 * Transparency itself produces no finding. `hasAlpha` and `isOpaque` are
 * properties of every PNG and WebP, not events; the first real project emitted
 * 55 notes that were almost entirely "this PNG has an alpha channel". They stay
 * in `ImageInfo` for `--json` and for fix planning, and they surface
 * here only when they change an answer, which is the `format: jpeg` case below.
 *
 * Format conversion also renames the file (`hero.png` -> `hero.webp`), which
 * can break references in source code, so `fix` requires explicit per-run
 * authorization (`--allow-renames`) before renaming anything.
 */
export function checkFormat(ctx: RuleContext): Finding[] {
  const { info: image, body, allGlobs } = ctx;
  const findings: Finding[] = [];

  // Animation is genuinely exceptional and changes what v0 will do, so unlike
  // transparency it is worth saying out loud on its own.
  if (image.isAnimated) {
    findings.push(info(ctx, 'animated', 'is animated; v0 does not transform animated images'));
  }

  const target = body.format;
  if (target === undefined) return findings;

  const owningGlob = sourceOf(ctx, 'format');

  // A conversion whose output matches no rule at all produces a file that
  // silently leaves policy. Worth saying out loud, violation or not.
  // (04, section 4, precondition 3.)
  //
  // Every glob is considered, not just the ones that matched: a rule written
  // for the target format governs the file only *after* the rename, so asking
  // `matchedGlobs` would report a file as leaving policy when it is landing in
  // a different part of it.
  if (owningGlob !== '(defaults)' && !allGlobs.some((glob) => globCoversTargetFormat(glob, image.path, target))) {
    findings.push(
      info(
        ctx,
        'ruleGlobExcludesTargetFormat',
        `after conversion to ${FORMAT_LABEL[target]} this file would no longer match any rule`,
        owningGlob,
      ),
    );
  }

  if (image.format === target) return findings;

  const blockers: string[] = [];
  if (target === 'jpeg' && hasMeaningfulAlpha(image)) {
    blockers.push('transparency present, and JPEG cannot represent it');
  }
  if (image.isAnimated) {
    blockers.push('image is animated, which v0 does not convert');
  }

  findings.push({
    path: image.path,
    rule: owningGlob,
    check: 'format',
    severity: 'error',
    actual: FORMAT_LABEL[image.format],
    allowed: FORMAT_LABEL[target],
    fixable: blockers.length > 0 ? 'no' : 'yes',
    message:
      blockers.length > 0
        ? blockers.join('; ')
        : 'converting renames the file, so fix will need --allow-renames',
  });

  return findings;
}
