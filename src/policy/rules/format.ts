import { globCoversTargetFormat } from '../../config/resolve.js';
import type { Note, Violation } from '../../types.js';
import { hasMeaningfulAlpha, type RuleContext, type RuleOutcome, sourceOf } from './types.js';

const LABEL = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP' } as const;

/**
 * `format`.
 *
 * A configured preferred format that differs from the file's current format is
 * a violation. Whether it is *safely* fixable is a separate question:
 *
 *   - JPEG cannot represent transparency. An image with meaningful alpha under
 *     a `format: jpeg` rule is reported as not fixable. Rasterwright will not
 *     guess a background colour, and `check` never flattens anything.
 *   - Animated images are out of scope for v0 and are reported as not fixable.
 *
 * Format conversion also renames the file (`hero.png` -> `hero.webp`), which
 * can break references in source code. `check` only reports; a future `fix`
 * will require explicit authorization before renaming anything.
 */
export function checkFormat(ctx: RuleContext): RuleOutcome {
  const { info, body, matchedGlobs } = ctx;
  const target = body.format;
  if (target === undefined) return { violations: [], notes: [] };

  const notes: Note[] = [];

  // A rule that converts to a format its own glob cannot match produces a file
  // that silently leaves policy. Worth saying out loud, whether or not this
  // particular file violates anything. (04, section 4, precondition 3.)
  const owningGlob = sourceOf(ctx, 'format');
  if (owningGlob !== '(defaults)' && !globCoversTargetFormat(owningGlob, info.path, target)) {
    notes.push({
      code: 'ruleGlobExcludesTargetFormat',
      message:
        `rule "${owningGlob}" asks for ${LABEL[target]}, but its own glob would not match the converted ` +
        `file; after conversion this file would no longer be governed`,
    });
  } else if (
    owningGlob !== '(defaults)' &&
    !matchedGlobs.some((glob) => globCoversTargetFormat(glob, info.path, target))
  ) {
    notes.push({
      code: 'ruleGlobExcludesTargetFormat',
      message: `after conversion to ${LABEL[target]} this file would no longer match any rule`,
    });
  }

  if (info.format === target) return { violations: [], notes };

  const blockers: string[] = [];
  if (target === 'jpeg' && hasMeaningfulAlpha(info)) {
    blockers.push('transparency present, and JPEG cannot represent it');
  }
  if (info.isAnimated) {
    blockers.push('image is animated, which v0 does not convert');
  }

  const violation: Violation = {
    path: info.path,
    rule: owningGlob,
    check: 'format',
    actual: LABEL[info.format],
    allowed: LABEL[target],
    fixable: blockers.length > 0 ? 'no' : 'yes',
    message:
      blockers.length > 0
        ? `${LABEL[info.format]}, expected ${LABEL[target]}; cannot convert safely: ${blockers.join('; ')}`
        : `${LABEL[info.format]}, expected ${LABEL[target]}; converting would rename the file to ` +
          `.${target === 'jpeg' ? 'jpg' : target}`,
  };

  if (hasMeaningfulAlpha(info)) {
    notes.push({
      code: 'transparency',
      message: 'image has meaningful transparency',
    });
  }
  if (info.isAnimated) {
    notes.push({ code: 'animated', message: 'image is animated; v0 does not transform animated images' });
  }

  return { violations: [violation], notes };
}
