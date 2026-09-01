import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { createResolver } from '../../src/config/resolve.js';
import { parsePolicy } from '../../src/config/schema.js';
import { aggregateFixability, evaluate, statusOf } from '../../src/policy/evaluate.js';
import type { EffectiveRule, Finding, ImageInfo, RuleBody, Severity } from '../../src/types.js';

/** A compliant baseline. Individual tests override just what they are testing. */
function image(overrides: Partial<ImageInfo> = {}): ImageInfo {
  return {
    path: 'assets/hero.jpg',
    bytes: 10_000,
    format: 'jpeg',
    width: 800,
    height: 600,
    storedWidth: 800,
    storedHeight: 600,
    hasAlpha: false,
    isOpaque: null,
    pixelColorSpace: 'srgb',
    colorSpaceStatus: 'srgb',
    hasIccProfile: false,
    iccDescription: null,
    hasExif: false,
    hasXmp: false,
    hasIptc: false,
    hasOtherMetadata: false,
    orientation: 1,
    isAnimated: false,
    contentHash: 'a'.repeat(64),
    ...overrides,
  };
}

function rule(body: RuleBody, matchedGlobs = ['assets/**']): EffectiveRule {
  const sources: EffectiveRule['sources'] = {};
  for (const key of Object.keys(body) as (keyof RuleBody)[]) sources[key] = matchedGlobs[0] ?? '(defaults)';
  return { body, matchedGlobs, sources };
}

/** Checks that produced a finding of the given severity, in order. */
function checks(info: ImageInfo, body: RuleBody, severity: Severity = 'error', globs?: string[]): string[] {
  return evaluate(info, rule(body, globs))
    .findings.filter((finding) => finding.severity === severity)
    .map((finding) => finding.check);
}

function findingFor(info: ImageInfo, body: RuleBody, check: string, globs?: string[]): Finding {
  const found = evaluate(info, rule(body, globs)).findings.find((finding) => finding.check === check);
  if (found === undefined) throw new Error(`no ${check} finding`);
  return found;
}

describe('severity', () => {
  it('makes constraint breaches errors', () => {
    expect(findingFor(image({ width: 6240 }), { maxWidth: 2400 }, 'maxWidth').severity).toBe('error');
    expect(findingFor(image({ height: 6240 }), { maxHeight: 2400 }, 'maxHeight').severity).toBe('error');
    expect(findingFor(image({ bytes: 900_000 }), { maxBytes: 500_000 }, 'maxBytes').severity).toBe('error');
    expect(findingFor(image(), { format: 'webp' }, 'format').severity).toBe('error');
    expect(findingFor(image({ orientation: 6 }), {}, 'orientation').severity).toBe('error');
    expect(
      findingFor(image({ colorSpaceStatus: 'non-srgb' }), { colorSpace: 'srgb' }, 'colorSpace').severity,
    ).toBe('error');
  });

  it('makes normalization preferences warnings', () => {
    expect(findingFor(image({ hasExif: true }), { stripMetadata: true }, 'metadata').severity).toBe('warning');
  });

  it('makes observations info', () => {
    expect(
      findingFor(image({ colorSpaceStatus: 'unknown' }), { colorSpace: 'srgb' }, 'colorSpaceUnknown').severity,
    ).toBe('info');
    expect(findingFor(image({ isAnimated: true }), {}, 'animated').severity).toBe('info');
  });

  it('gives a file the status of its worst finding', () => {
    expect(evaluate(image(), rule({})).status).toBe('clean');
    expect(evaluate(image({ isAnimated: true }), rule({})).status).toBe('info');
    expect(evaluate(image({ hasExif: true }), rule({ stripMetadata: true })).status).toBe('warning');
    expect(evaluate(image({ width: 9000 }), rule({ maxWidth: 100, stripMetadata: true })).status).toBe('error');
  });

  it('computes status directly from findings', () => {
    const base = { path: 'a', rule: 'r', check: 'metadata', actual: null, allowed: null, message: '' } as const;
    expect(statusOf([])).toBe('clean');
    expect(statusOf([{ ...base, severity: 'info', fixable: 'n/a' }])).toBe('info');
    expect(statusOf([{ ...base, severity: 'warning', fixable: 'yes' }])).toBe('warning');
    expect(
      statusOf([
        { ...base, severity: 'warning', fixable: 'yes' },
        { ...base, severity: 'error', fixable: 'yes' },
      ]),
    ).toBe('error');
  });
});

describe('maxWidth / maxHeight', () => {
  it('passes when within bounds, including exactly at the limit', () => {
    expect(checks(image({ width: 2400 }), { maxWidth: 2400 })).toEqual([]);
    expect(checks(image({ height: 600 }), { maxHeight: 600 })).toEqual([]);
  });

  it('flags an image wider than maxWidth', () => {
    expect(findingFor(image({ width: 6240 }), { maxWidth: 2400 }, 'maxWidth')).toMatchObject({
      severity: 'error',
      actual: 6240,
      allowed: 2400,
      fixable: 'yes',
      rule: 'assets/**',
    });
  });

  it('flags an image taller than maxHeight', () => {
    expect(checks(image({ height: 1400 }), { maxHeight: 600 })).toEqual(['maxHeight']);
  });

  it('measures the displayed dimensions, not the stored ones', () => {
    // Orientation 6: stored landscape, displayed portrait.
    const rotated = image({ width: 400, height: 600, storedWidth: 600, storedHeight: 400, orientation: 6 });
    expect(checks(rotated, { maxWidth: 500 })).toEqual(['orientation']);
    expect(checks(rotated, { maxHeight: 500 })).toEqual(['maxHeight', 'orientation']);
  });
});

describe('maxBytes', () => {
  it('treats the budget as a ceiling, not a target', () => {
    // Far under budget is fine. Rasterwright never grows a file to fill it.
    expect(checks(image({ bytes: 1000 }), { maxBytes: 500_000 })).toEqual([]);
    expect(checks(image({ bytes: 500_000 }), { maxBytes: 500_000 })).toEqual([]);
  });

  it('flags a file over budget as an error whose fixability is unknown', () => {
    const result = evaluate(image({ bytes: 8_178_892 }), rule({ maxBytes: 409_600 }));
    expect(result.findings[0]).toMatchObject({
      check: 'maxBytes',
      severity: 'error',
      actual: 8_178_892,
      allowed: 409_600,
      fixable: 'unknown',
    });
    expect(result.fixable).toBe('unknown');
  });

  it('stays unknown regardless of format, because check never encodes', () => {
    for (const format of ['jpeg', 'png', 'webp'] as const) {
      expect(findingFor(image({ format, bytes: 900_000 }), { maxBytes: 100 }, 'maxBytes').fixable).toBe('unknown');
    }
  });
});

describe('format', () => {
  it('passes when the format already matches', () => {
    expect(checks(image({ path: 'assets/hero.webp', format: 'webp' }), { format: 'webp' })).toEqual([]);
  });

  it('flags a mismatched format as a fixable error that will need a rename', () => {
    const finding = findingFor(image({ format: 'jpeg' }), { format: 'webp' }, 'format');
    expect(finding).toMatchObject({ severity: 'error', actual: 'JPEG', allowed: 'WebP', fixable: 'yes' });
    expect(finding.message).toMatch(/--allow-renames/);
  });

  it('refuses to call a transparent PNG safely convertible to JPEG', () => {
    const logo = image({ path: 'assets/logo.png', format: 'png', hasAlpha: true, isOpaque: false });
    const result = evaluate(logo, rule({ format: 'jpeg' }));
    expect(result.findings.find((f) => f.check === 'format')).toMatchObject({
      severity: 'error',
      fixable: 'no',
      message: expect.stringMatching(/transparency present/),
    });
    expect(result.fixable).toBe('no');
  });

  it('allows JPEG conversion when the alpha channel is provably unused', () => {
    const opaque = image({ path: 'assets/logo.png', format: 'png', hasAlpha: true, isOpaque: true });
    expect(findingFor(opaque, { format: 'jpeg' }, 'format').fixable).toBe('yes');
  });

  it('assumes transparency when opacity could not be determined', () => {
    const unknown = image({ path: 'assets/logo.png', format: 'png', hasAlpha: true, isOpaque: null });
    expect(findingFor(unknown, { format: 'jpeg' }, 'format').fixable).toBe('no');
  });

  it('will not convert an animated image', () => {
    const animated = image({ path: 'assets/loop.webp', format: 'webp', isAnimated: true });
    const finding = findingFor(animated, { format: 'jpeg' }, 'format');
    expect(finding).toMatchObject({ fixable: 'no' });
    expect(finding.message).toMatch(/animated/);
  });

  it('notes when converting would take the file out of its own rule', () => {
    const policy = parsePolicy(
      parseYaml(`
version: 1
rules:
  "assets/**/*.{jpg,jpeg,png}":
    format: webp
`),
    );
    const resolved = createResolver(policy).resolve('assets/hero.png');
    const result = evaluate(image({ path: 'assets/hero.png', format: 'png' }), resolved);
    const note = result.findings.find((f) => f.check === 'ruleGlobExcludesTargetFormat');
    expect(note?.severity).toBe('info');
  });

  it('stays quiet when the rule glob does cover the target format', () => {
    const policy = parsePolicy(
      parseYaml(`
version: 1
rules:
  "assets/**/*.{jpg,jpeg,png,webp}":
    format: webp
`),
    );
    const resolved = createResolver(policy).resolve('assets/hero.png');
    const result = evaluate(image({ path: 'assets/hero.png', format: 'png' }), resolved);
    expect(result.findings.map((f) => f.check)).not.toContain('ruleGlobExcludesTargetFormat');
  });
});

describe('extension versus contents', () => {
  it('flags a WebP hiding behind a .png extension', () => {
    const finding = findingFor(image({ path: 'assets/logo.png', format: 'webp' }), {}, 'extension');
    expect(finding).toMatchObject({
      severity: 'error',
      actual: 'WebP',
      allowed: 'PNG',
      fixable: 'yes',
      rule: '(built-in)',
    });
  });

  it('accepts .jpg and .jpeg as the same format', () => {
    expect(checks(image({ path: 'assets/a.jpg', format: 'jpeg' }), {})).toEqual([]);
    expect(checks(image({ path: 'assets/a.jpeg', format: 'jpeg' }), {})).toEqual([]);
  });

  it('is case-insensitive about the extension itself', () => {
    expect(checks(image({ path: 'assets/A.JPG', format: 'jpeg' }), {})).toEqual([]);
    expect(checks(image({ path: 'assets/A.PNG', format: 'jpeg' }), {})).toEqual(['extension']);
  });

  it('catches every direction of mismatch', () => {
    expect(checks(image({ path: 'a.png', format: 'jpeg' }), {})).toEqual(['extension']);
    expect(checks(image({ path: 'a.jpg', format: 'png' }), {})).toEqual(['extension']);
    expect(checks(image({ path: 'a.webp', format: 'png' }), {})).toEqual(['extension']);
  });

  it('is independent of the format rule, which reads the contents', () => {
    // A .png that is really WebP, under a rule that asks for WebP: the format
    // check is satisfied by the contents, the extension check is not.
    const result = evaluate(image({ path: 'assets/logo.png', format: 'webp' }), rule({ format: 'webp' }));
    expect(result.findings.filter((f) => f.severity === 'error').map((f) => f.check)).toEqual(['extension']);
  });
});

describe('metadata', () => {
  it('is a warning, not an error', () => {
    const result = evaluate(image({ hasExif: true }), rule({ stripMetadata: true }));
    expect(result.status).toBe('warning');
    expect(result.findings[0]).toMatchObject({ check: 'metadata', severity: 'warning', fixable: 'yes' });
  });

  it('reports EXIF, XMP, IPTC and other ancillary blocks separately', () => {
    expect(findingFor(image({ hasExif: true }), { stripMetadata: true }, 'metadata').actual).toBe('EXIF');
    expect(findingFor(image({ hasXmp: true }), { stripMetadata: true }, 'metadata').actual).toBe('XMP');
    expect(findingFor(image({ hasIptc: true }), { stripMetadata: true }, 'metadata').actual).toBe('IPTC');
    expect(findingFor(image({ hasOtherMetadata: true }), { stripMetadata: true }, 'metadata').actual).toBe(
      'other ancillary metadata',
    );
    expect(
      findingFor(image({ hasExif: true, hasXmp: true }), { stripMetadata: true }, 'metadata').actual,
    ).toBe('EXIF, XMP');
  });

  it('does NOT treat an ICC profile as removable metadata', () => {
    // A colour profile is colour management, not baggage. An sRGB-tagged image
    // under `colorSpace: srgb` is doing exactly what was asked.
    const tagged = image({ hasIccProfile: true, iccDescription: 'sRGB IEC61966-2.1', colorSpaceStatus: 'srgb' });
    const result = evaluate(tagged, rule({ stripMetadata: true, colorSpace: 'srgb' }));
    expect(result.findings).toEqual([]);
    expect(result.status).toBe('clean');
  });

  it('still warns about EXIF on an image that also carries an sRGB profile', () => {
    const both = image({ hasExif: true, hasIccProfile: true, iccDescription: 'GIMP built-in sRGB' });
    expect(findingFor(both, { stripMetadata: true, colorSpace: 'srgb' }, 'metadata').actual).toBe('EXIF');
  });

  it('says nothing when there is no metadata', () => {
    expect(evaluate(image(), rule({ stripMetadata: true })).findings).toEqual([]);
  });

  it('says nothing when the policy does not ask for stripping', () => {
    expect(evaluate(image({ hasExif: true, hasXmp: true }), rule({ stripMetadata: false })).findings).toEqual([]);
  });
});

describe('colorSpace', () => {
  it('passes a confidently sRGB image', () => {
    expect(checks(image({ colorSpaceStatus: 'srgb' }), { colorSpace: 'srgb' })).toEqual([]);
  });

  it('flags a confidently non-sRGB image as an error', () => {
    const cmyk = image({ colorSpaceStatus: 'non-srgb', pixelColorSpace: 'cmyk' });
    expect(findingFor(cmyk, { colorSpace: 'srgb' }, 'colorSpace')).toMatchObject({
      severity: 'error',
      actual: 'cmyk',
      allowed: 'sRGB',
      fixable: 'yes',
    });
  });

  it('names the profile when one was readable', () => {
    const p3 = image({ colorSpaceStatus: 'non-srgb', iccDescription: 'Display P3' });
    expect(findingFor(p3, { colorSpace: 'srgb' }, 'colorSpace').actual).toBe('Display P3');
  });

  it('keeps an unidentifiable profile informational, and out of the exit code', () => {
    const result = evaluate(image({ colorSpaceStatus: 'unknown', hasIccProfile: true }), rule({ colorSpace: 'srgb' }));
    expect(result.findings.map((f) => f.check)).toEqual(['colorSpaceUnknown']);
    expect(result.findings[0]!.severity).toBe('info');
    expect(result.status).toBe('info');
  });
});

describe('orientation', () => {
  it('passes a normal orientation', () => {
    expect(checks(image({ orientation: 1 }), {})).toEqual([]);
  });

  it('is an error when autoOrient is on, which is the default', () => {
    const rotated = image({ orientation: 6, storedWidth: 600, storedHeight: 400, width: 400, height: 600 });
    expect(findingFor(rotated, {}, 'orientation')).toMatchObject({
      severity: 'error',
      actual: 6,
      allowed: 1,
      fixable: 'yes',
    });
    expect(findingFor(rotated, { autoOrient: true }, 'orientation').severity).toBe('error');
  });

  it('says nothing at all when autoOrient is off', () => {
    const rotated = image({ orientation: 6 });
    expect(evaluate(rotated, rule({ autoOrient: false })).findings).toEqual([]);
    expect(evaluate(rotated, rule({ autoOrient: false })).status).toBe('clean');
  });

  it('leaves other checks alone when autoOrient is off', () => {
    const rotated = image({ orientation: 6, hasExif: true });
    expect(checks(rotated, { autoOrient: false, stripMetadata: true }, 'warning')).toEqual(['metadata']);
  });
});

describe('transparency', () => {
  // Alpha is a property of most PNGs and WebPs, not an event. It belongs on
  // ImageInfo, and surfaces as a finding only where it changes an answer.
  it('produces no finding of its own when the alpha channel is used', () => {
    const png = image({ path: 'assets/logo.png', hasAlpha: true, isOpaque: false, format: 'png' });
    expect(evaluate(png, rule({ format: 'png' })).findings).toEqual([]);
    expect(evaluate(png, rule({ format: 'png' })).status).toBe('clean');
  });

  it('produces no finding when the alpha channel is unused either', () => {
    const png = image({ path: 'assets/logo.png', hasAlpha: true, isOpaque: true, format: 'png' });
    expect(evaluate(png, rule({ format: 'png' })).findings).toEqual([]);
    expect(evaluate(png, rule({ format: 'png' })).status).toBe('clean');
  });

  it('still blocks a JPEG conversion, which is where alpha changes the answer', () => {
    const png = image({ path: 'assets/logo.png', hasAlpha: true, isOpaque: false, format: 'png' });
    const finding = findingFor(png, { format: 'jpeg' }, 'format');
    expect(finding.fixable).toBe('no');
    expect(finding.message).toMatch(/transparency present/);
  });

  it('says nothing about an image with no alpha channel', () => {
    expect(evaluate(image({ hasAlpha: false }), rule({})).findings).toEqual([]);
  });
});

describe('aggregateFixability', () => {
  const base = { path: 'a', rule: 'r', check: 'maxWidth', actual: 1, allowed: 1, message: '' } as const;

  it('is yes when there is nothing to fix', () => {
    expect(aggregateFixability([])).toBe('yes');
  });

  it('is pessimistic: any no wins, then any unknown', () => {
    expect(
      aggregateFixability([
        { ...base, severity: 'error', fixable: 'yes' },
        { ...base, severity: 'error', fixable: 'unknown' },
      ]),
    ).toBe('unknown');
    expect(
      aggregateFixability([
        { ...base, severity: 'error', fixable: 'unknown' },
        { ...base, severity: 'error', fixable: 'no' },
      ]),
    ).toBe('no');
  });

  it('ignores informational findings, which have nothing to fix', () => {
    expect(
      aggregateFixability([
        { ...base, check: 'animated', severity: 'info', fixable: 'n/a' },
        { ...base, severity: 'error', fixable: 'yes' },
      ]),
    ).toBe('yes');
  });
});

describe('evaluate', () => {
  it('reports a fully compliant file with no findings', () => {
    const result = evaluate(image(), rule({ maxWidth: 2400, maxBytes: 500_000, format: 'jpeg' }));
    expect(result.status).toBe('clean');
    expect(result.findings).toEqual([]);
    expect(result.fixable).toBe('yes');
  });

  it('accumulates findings in a fixed order', () => {
    const bad = image({ path: 'assets/hero.jpg', width: 6240, bytes: 8_000_000, format: 'jpeg', hasExif: true });
    const result = evaluate(bad, rule({ maxWidth: 2400, maxBytes: 409_600, format: 'webp', stripMetadata: true }));
    expect(result.findings.map((f) => f.check)).toEqual(['maxWidth', 'maxBytes', 'format', 'metadata']);
  });
});
