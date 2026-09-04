import path from 'node:path';

import type { Finding, ImageFormat } from '../../types.js';
import { FORMAT_LABEL, type RuleContext } from './types.js';

/**
 * File extension versus actual encoded format.
 *
 * A real theme turned up `logo-transparent.png` that Sharp decodes as
 * WebP. Nothing in the policy caught it, and nothing would have: every other
 * check reads the format from the file's contents, so the file looked fine.
 *
 * This is an error. Extensions are load-bearing well outside Rasterwright:
 * web servers pick a Content-Type from them, bundlers pick a loader, CDNs and
 * caches key on them, and image CDNs pick a transform pipeline. A `.png` that
 * is really a WebP is a latent bug in every one of those.
 *
 * `.jpg` and `.jpeg` are the same format and neither is a mismatch.
 */
export const EXTENSION_FORMATS: Record<string, ImageFormat> = {
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
};

export function checkExtension(ctx: RuleContext): Finding[] {
  const { info } = ctx;
  const extension = path.posix.extname(info.path).toLowerCase();
  const expected = EXTENSION_FORMATS[extension];

  // An extension we do not map is not a mismatch we can assert anything about.
  if (expected === undefined || expected === info.format) return [];

  return [
    {
      path: info.path,
      rule: '(built-in)',
      check: 'extension',
      severity: 'error',
      // `actual` is the truth about the bytes; `allowed` is what the filename claims.
      actual: FORMAT_LABEL[info.format],
      allowed: FORMAT_LABEL[expected],
      fixable: 'yes',
      message:
        `contents are ${FORMAT_LABEL[info.format]} but the extension says ${FORMAT_LABEL[expected]}; ` +
        'fix would rename the file to match its contents, so it will need --allow-renames',
    },
  ];
}
