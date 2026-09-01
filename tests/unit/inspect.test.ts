import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { classifyColorSpace, inspect } from '../../src/scanner/inspect.js';
import { readIccSummary } from '../../src/utils/icc.js';
import { FIXTURE_IMAGES } from '../helpers/project.js';

/** Every test here runs against a real image file, not a hand-built ImageInfo. */
async function info(name: string) {
  const result = await inspect(FIXTURE_IMAGES, name);
  if (!result.ok) throw new Error(`expected ${name} to inspect cleanly: ${result.error}`);
  return result.info;
}

describe('inspect', () => {
  it('reads a plain JPEG', async () => {
    const jpeg = await info('compliant.jpg');
    expect(jpeg).toMatchObject({
      path: 'compliant.jpg',
      format: 'jpeg',
      width: 600,
      height: 400,
      storedWidth: 600,
      storedHeight: 400,
      hasAlpha: false,
      orientation: 1,
      isAnimated: false,
      colorSpaceStatus: 'srgb',
      hasExif: false,
      hasIccProfile: false,
    });
    expect(jpeg.bytes).toBe(fs.statSync(path.join(FIXTURE_IMAGES, 'compliant.jpg')).size);
  });

  it('hashes the file bytes', async () => {
    const jpeg = await info('compliant.jpg');
    const expected = createHash('sha256')
      .update(fs.readFileSync(path.join(FIXTURE_IMAGES, 'compliant.jpg')))
      .digest('hex');
    expect(jpeg.contentHash).toBe(expected);
  });

  it('reads PNG and WebP', async () => {
    expect(await info('plain.png')).toMatchObject({ format: 'png', width: 400, height: 300 });
    expect(await info('sample.webp')).toMatchObject({ format: 'webp', width: 500, height: 400 });
  });

  it('distinguishes a used alpha channel from an unused one', async () => {
    expect(await info('transparent.png')).toMatchObject({ hasAlpha: true, isOpaque: false });
    expect(await info('opaque-alpha.png')).toMatchObject({ hasAlpha: true, isOpaque: true });
  });

  it('leaves isOpaque null when there is no alpha channel to examine', async () => {
    expect((await info('plain.png')).isOpaque).toBeNull();
  });

  it('reports displayed dimensions for an EXIF-rotated image', async () => {
    // Stored 600x400 landscape, orientation 6, so it displays as 400x600.
    expect(await info('rotated.jpg')).toMatchObject({
      orientation: 6,
      storedWidth: 600,
      storedHeight: 400,
      width: 400,
      height: 600,
    });
  });

  it('detects EXIF', async () => {
    expect(await info('with-exif.jpg')).toMatchObject({ hasExif: true, hasXmp: false });
  });

  it('detects XMP separately from EXIF', async () => {
    expect(await info('with-xmp.png')).toMatchObject({ hasXmp: true, hasExif: false });
  });

  it('reads the encoded format from the contents, not the extension', async () => {
    // A WebP saved as .png. Every other check reads `format`, so without this
    // the file looks entirely healthy.
    expect(await info('webp-named-png.png')).toMatchObject({ format: 'webp' });
    expect(await info('aliased.jpeg')).toMatchObject({ format: 'jpeg' });
  });

  it('reports an explicit sRGB profile as sRGB, not as unknown', async () => {
    expect(await info('srgb-profile.png')).toMatchObject({
      hasIccProfile: true,
      iccDescription: 'sRGB',
      colorSpaceStatus: 'srgb',
      hasExif: false,
      hasXmp: false,
    });
  });

  it('detects CMYK as confidently non-sRGB', async () => {
    expect(await info('cmyk.jpg')).toMatchObject({ pixelColorSpace: 'cmyk', colorSpaceStatus: 'non-srgb' });
  });

  it('identifies an embedded sRGB profile', async () => {
    const rotated = await info('rotated.jpg');
    expect(rotated.hasIccProfile).toBe(true);
    expect(rotated.iccDescription).toBe('sRGB');
    expect(rotated.colorSpaceStatus).toBe('srgb');
  });

  it('reports a corrupt file as an error rather than throwing', async () => {
    const result = await inspect(FIXTURE_IMAGES, 'corrupt.jpg');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not decode image/);
  });

  it('reports a missing file as an error', async () => {
    const result = await inspect(FIXTURE_IMAGES, 'nope.jpg');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not read file/);
  });
});

describe('classifyColorSpace', () => {
  it('calls untagged RGB sRGB, by the web convention', () => {
    expect(classifyColorSpace('srgb', undefined)).toBe('srgb');
    expect(classifyColorSpace('b-w', undefined)).toBe('srgb');
  });

  it('calls CMYK pixels non-sRGB regardless of any profile', () => {
    expect(classifyColorSpace('cmyk', undefined)).toBe('non-srgb');
  });

  it('trusts a profile description that names sRGB', () => {
    expect(classifyColorSpace('srgb', { description: 'sRGB IEC61966-2.1', dataColorSpace: 'RGB' })).toBe('srgb');
  });

  it('calls a named non-sRGB profile non-sRGB', () => {
    expect(classifyColorSpace('srgb', { description: 'Display P3', dataColorSpace: 'RGB' })).toBe('non-srgb');
  });

  it('refuses to guess when the profile could not be read', () => {
    expect(classifyColorSpace('srgb', { description: undefined, dataColorSpace: 'RGB' })).toBe('unknown');
  });
});

describe('readIccSummary', () => {
  it('returns nothing useful for a buffer that is not a profile', () => {
    expect(readIccSummary(Buffer.alloc(8))).toEqual({ description: undefined, dataColorSpace: undefined });
  });

  it('does not throw on a truncated profile', () => {
    expect(() => readIccSummary(Buffer.alloc(200, 0xff))).not.toThrow();
  });
});
