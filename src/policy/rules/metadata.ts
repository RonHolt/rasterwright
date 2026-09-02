import type { Finding } from '../../types.js';
import { type RuleContext, sourceOf } from './types.js';

/**
 * `stripMetadata`. A WARNING, never an error.
 *
 * The first real run against a production theme found 3 genuine constraint
 * violations and 17 files carrying harmless EXIF. Failing the run over the
 * latter buried the former. So `stripMetadata: true` is read as a
 * normalization *preference*:
 *
 *   "if Rasterwright ever rewrites this file, drop the ancillary metadata"
 *
 * not as "any EXIF anywhere means this repository is broken". If a project
 * genuinely needs metadata to be a hard gate, that is a future option; nothing
 * observed so far justifies one.
 *
 * ICC profiles are deliberately NOT counted here. A colour profile is colour
 * management, not disposable baggage, and an image tagged `sRGB IEC61966-2.1`
 * is doing exactly what `colorSpace: srgb` asked for. See `colorSpace.ts`.
 */
export function checkMetadata(ctx: RuleContext): Finding[] {
  const { info, body } = ctx;
  if (body.stripMetadata !== true) return [];

  const present: string[] = [];
  if (info.hasExif) present.push('EXIF');
  if (info.hasXmp) present.push('XMP');
  if (info.hasIptc) present.push('IPTC');
  if (info.hasOtherMetadata) present.push('other ancillary metadata');
  if (present.length === 0) return [];

  return [
    {
      path: info.path,
      rule: sourceOf(ctx, 'stripMetadata'),
      check: 'metadata',
      severity: 'warning',
      actual: present.join(', '),
      allowed: 'none',
      fixable: 'yes',
      message: `${present.join(', ')} present; a fix would remove it`,
    },
  ];
}
