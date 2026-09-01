import { globCoversTargetFormat } from '../../config/resolve.js';
import type { Finding } from '../../types.js';
import { FORMAT_LABEL, hasMeaningfulAlpha, hasUnusedAlpha, info, type RuleContext, sourceOf } from './types.js';

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
 * Format conversion also renames the file (`hero.png` -> `hero.webp`), which
 * can break references in source code. A future `fix` will require explicit
 * per-run authorization (`--allow-renames`) before renaming anything.
 */
export function checkFormat(ctx: RuleContext): Finding[] {
  const { info: image, body, matchedGlobs } = ctx;
  const findings: Finding[] = [];

  // Transparency is information, not a violation. It explains what a future
  // conversion can and cannot do, so it is reported whatever the policy says.
  if (hasMeaningfulAlpha(image)) {
    findings.push(info(ctx, 'transparency', 'has meaningful transparency'));
  } else if (hasUnusedAlpha(image)) {
    findings.push(
      info(
        ctx,
        'alphaUnused',
        'has an alpha channel in which every pixel is opaque; fix will not rewrite the file just to drop it',
      ),
    );
  }
  if (image.isAnimated) {
    findings.push(info(ctx, 'animated', 'is animated; v0 does not transform animated images'));
  }

  const target = body.format;
  if (target === undefined) return findings;

  const owningGlob = sourceOf(ctx, 'format');

  // A rule that converts to a format its own glob cannot match produces a file
  // that silently leaves policy. Worth saying out loud, violation or not.
  // (04, section 4, precondition 3.)
  if (owningGlob !== '(defaults)' && !matchedGlobs.some((glob) => globCoversTargetFormat(glob, image.path, target))) {
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
