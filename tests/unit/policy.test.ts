import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { createResolver } from '../../src/config/resolve.js';
import { parsePolicy } from '../../src/config/schema.js';
import { aggregateFixability, evaluate } from '../../src/policy/evaluate.js';
import type { EffectiveRule, ImageInfo, RuleBody } from '../../src/types.js';

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

function checks(info: ImageInfo, body: RuleBody, globs?: string[]): string[] {
  return evaluate(info, rule(body, globs)).violations.map((violation) => violation.check);
}

describe('maxWidth / maxHeight', () => {
  it('passes when within bounds, including exactly at the limit', () => {
    expect(checks(image({ width: 2400 }), { maxWidth: 2400 })).toEqual([]);
    expect(checks(image({ height: 600 }), { maxHeight: 600 })).toEqual([]);
  });

  it('flags an image wider than maxWidth', () => {
    const result = evaluate(image({ width: 6240 }), rule({ maxWidth: 2400 }));
    expect(result.status).toBe('violating');
    expect(result.violations[0]).toMatchObject({
      check: 'maxWidth',
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

  it('flags a file over budget with unknown fixability', () => {
    const result = evaluate(image({ bytes: 8_178_892 }), rule({ maxBytes: 409_600 }));
    expect(result.violations[0]).toMatchObject({
      check: 'maxBytes',
      actual: 8_178_892,
      allowed: 409_600,
      fixable: 'unknown',
    });
    expect(result.fixable).toBe('unknown');
  });
});

describe('format', () => {
  it('passes when the format already matches', () => {
    expect(checks(image({ format: 'webp' }), { format: 'webp' })).toEqual([]);
  });

  it('flags a mismatched format as fixable', () => {
    const result = evaluate(image({ format: 'jpeg' }), rule({ format: 'webp' }, ['assets/**']));
    expect(result.violations[0]).toMatchObject({ check: 'format', actual: 'JPEG', allowed: 'WebP', fixable: 'yes' });
    expect(result.violations[0]!.message).toMatch(/rename the file to \.webp/);
  });

  it('refuses to call a transparent PNG safely convertible to JPEG', () => {
    const logo = image({ path: 'assets/logo.png', format: 'png', hasAlpha: true, isOpaque: false });
    const result = evaluate(logo, rule({ format: 'jpeg' }));
    expect(result.violations[0]).toMatchObject({ check: 'format', fixable: 'no' });
    expect(result.violations[0]!.message).toMatch(/transparency present/);
    expect(result.fixable).toBe('no');
    expect(result.notes.map((note) => note.code)).toContain('transparency');
  });

  it('allows JPEG conversion when the alpha channel is provably unused', () => {
    const opaque = image({ path: 'assets/logo.png', format: 'png', hasAlpha: true, isOpaque: true });
    expect(evaluate(opaque, rule({ format: 'jpeg' })).violations[0]).toMatchObject({ fixable: 'yes' });
  });

  it('assumes transparency when opacity could not be determined', () => {
    const unknown = image({ path: 'assets/logo.png', format: 'png', hasAlpha: true, isOpaque: null });
    expect(evaluate(unknown, rule({ format: 'jpeg' })).violations[0]).toMatchObject({ fixable: 'no' });
  });

  it('will not convert an animated image', () => {
    const animated = image({ path: 'assets/loop.webp', format: 'webp', isAnimated: true });
    const result = evaluate(animated, rule({ format: 'jpeg' }));
    expect(result.violations[0]).toMatchObject({ fixable: 'no' });
    expect(result.violations[0]!.message).toMatch(/animated/);
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
    expect(result.notes.map((note) => note.code)).toContain('ruleGlobExcludesTargetFormat');
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
    expect(result.notes.map((note) => note.code)).not.toContain('ruleGlobExcludesTargetFormat');
  });
});

describe('metadata', () => {
  it('reports only what Sharp actually exposes', () => {
    const result = evaluate(image({ hasExif: true, hasIccProfile: true }), rule({ stripMetadata: true }));
    expect(result.violations[0]).toMatchObject({
      check: 'metadata',
      actual: 'EXIF, ICC profile',
      allowed: 'none',
      fixable: 'yes',
    });
  });

  it('says nothing when there is no metadata', () => {
    expect(checks(image(), { stripMetadata: true })).toEqual([]);
  });

  it('says nothing when the policy does not ask for stripping', () => {
    expect(checks(image({ hasExif: true, hasXmp: true }), { stripMetadata: false })).toEqual([]);
  });
});

describe('colorSpace', () => {
  it('passes a confidently sRGB image', () => {
    expect(checks(image({ colorSpaceStatus: 'srgb' }), { colorSpace: 'srgb' })).toEqual([]);
  });

  it('flags a confidently non-sRGB image', () => {
    const cmyk = image({ colorSpaceStatus: 'non-srgb', pixelColorSpace: 'cmyk' });
    expect(evaluate(cmyk, rule({ colorSpace: 'srgb' })).violations[0]).toMatchObject({
      check: 'colorSpace',
      actual: 'cmyk',
      allowed: 'sRGB',
      fixable: 'yes',
    });
  });

  it('names the profile when one was readable', () => {
    const p3 = image({ colorSpaceStatus: 'non-srgb', iccDescription: 'Display P3' });
    expect(evaluate(p3, rule({ colorSpace: 'srgb' })).violations[0]!.actual).toBe('Display P3');
  });

  it('does not turn an unidentifiable profile into a violation, but does note it', () => {
    const result = evaluate(image({ colorSpaceStatus: 'unknown', hasIccProfile: true }), rule({ colorSpace: 'srgb' }));
    expect(result.violations.map((violation) => violation.check)).toEqual([]);
    expect(result.notes.map((note) => note.code)).toContain('colorSpaceUnknown');
    expect(result.status).toBe('compliant');
  });
});

describe('orientation', () => {
  it('passes a normal orientation', () => {
    expect(checks(image({ orientation: 1 }), {})).toEqual([]);
  });

  it('flags a non-normal orientation regardless of configuration', () => {
    const result = evaluate(image({ orientation: 6, storedWidth: 600, storedHeight: 400, width: 400, height: 600 }), rule({}));
    expect(result.violations[0]).toMatchObject({
      check: 'orientation',
      actual: 6,
      allowed: 1,
      fixable: 'yes',
      rule: '(built-in)',
    });
  });
});

describe('aggregateFixability', () => {
  it('is yes when there is nothing to fix', () => {
    expect(aggregateFixability([])).toBe('yes');
  });

  it('is pessimistic: any no wins, then any unknown', () => {
    const base = { path: 'a', rule: 'r', check: 'maxWidth', actual: 1, allowed: 1, message: '' } as const;
    expect(aggregateFixability([{ ...base, fixable: 'yes' }, { ...base, fixable: 'unknown' }])).toBe('unknown');
    expect(aggregateFixability([{ ...base, fixable: 'unknown' }, { ...base, fixable: 'no' }])).toBe('no');
  });
});

describe('evaluate', () => {
  it('reports a fully compliant file with no violations', () => {
    const result = evaluate(image(), rule({ maxWidth: 2400, maxBytes: 500_000, format: 'jpeg' }));
    expect(result.status).toBe('compliant');
    expect(result.violations).toEqual([]);
    expect(result.fixable).toBe('yes');
  });

  it('accumulates several violations in a fixed order', () => {
    const bad = image({ width: 6240, bytes: 8_000_000, format: 'jpeg', hasExif: true });
    expect(checks(bad, { maxWidth: 2400, maxBytes: 409_600, format: 'webp', stripMetadata: true })).toEqual([
      'maxWidth',
      'maxBytes',
      'format',
      'metadata',
    ]);
  });
});
