import type { Note, Violation } from '../../types.js';
import { type RuleContext, type RuleOutcome, sourceOf } from './types.js';

/**
 * `colorSpace: srgb`.
 *
 * Three-valued, on purpose (see `scanner/inspect.ts#classifyColorSpace`):
 *
 *   - 'non-srgb' is a violation.
 *   - 'srgb' is compliant.
 *   - 'unknown' is NOT reported as a violation and NOT silently counted as
 *     compliant. It is surfaced as a note so the file is visible without
 *     failing a build over something Rasterwright could not determine. This is
 *     a deliberate v0 decision: false positives here would train people to
 *     ignore the tool.
 */
export function checkColorSpace(ctx: RuleContext): RuleOutcome {
  const { info, body } = ctx;
  if (body.colorSpace !== 'srgb') return { violations: [], notes: [] };

  if (info.colorSpaceStatus === 'srgb') return { violations: [], notes: [] };

  if (info.colorSpaceStatus === 'unknown') {
    const notes: Note[] = [
      {
        code: 'colorSpaceUnknown',
        message:
          'an ICC profile is present but could not be identified, so sRGB compliance is unknown; ' +
          'not reported as a violation',
      },
    ];
    return { violations: [], notes };
  }

  const described = info.iccDescription ?? info.pixelColorSpace;
  const violation: Violation = {
    path: info.path,
    rule: sourceOf(ctx, 'colorSpace'),
    check: 'colorSpace',
    actual: described,
    allowed: 'sRGB',
    fixable: 'yes',
    message: `colour space is ${described}, policy requires sRGB`,
  };

  return { violations: [violation], notes: [] };
}
