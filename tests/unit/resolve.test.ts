import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { parsePolicy } from '../../src/config/schema.js';
import { createResolver, globCoversTargetFormat } from '../../src/config/resolve.js';

function resolverFor(yaml: string) {
  return createResolver(parsePolicy(parseYaml(yaml)));
}

const OVERLAPPING = `
version: 1
defaults:
  stripMetadata: true
  colorSpace: srgb
rules:
  "assets/**/*.{jpg,jpeg,png,webp}":
    maxWidth: 2400
    maxBytes: 500kb
  "assets/heroes/**":
    maxWidth: 800
    format: webp
  "assets/heroes/wide/**":
    maxWidth: 1600
`;

describe('rule precedence', () => {
  it('merges defaults with every matching rule in file order', () => {
    const rule = resolverFor(OVERLAPPING).resolve('assets/heroes/hero.jpg');

    expect(rule.matchedGlobs).toEqual(['assets/**/*.{jpg,jpeg,png,webp}', 'assets/heroes/**']);
    expect(rule.body).toEqual({
      upscale: false,
      stripMetadata: true,
      autoOrient: true,
      colorSpace: 'srgb',
      // The later rule overrode maxWidth...
      maxWidth: 800,
      // ...but left maxBytes from the earlier one intact. Shallow, per-property merge.
      maxBytes: 512_000,
      format: 'webp',
    });
  });

  it('lets the last matching rule win, not the most specific one', () => {
    // "assets/heroes/**" appears before "assets/heroes/wide/**", so the latter wins.
    const rule = resolverFor(OVERLAPPING).resolve('assets/heroes/wide/banner.jpg');
    expect(rule.body.maxWidth).toBe(1600);
    expect(rule.body.format).toBe('webp');
  });

  it('is decided by file order, so reversing the file reverses the outcome', () => {
    const reversed = resolverFor(`
version: 1
rules:
  "assets/heroes/**":
    maxWidth: 800
  "assets/**/*.jpg":
    maxWidth: 2400
`);
    expect(reversed.resolve('assets/heroes/hero.jpg').body.maxWidth).toBe(2400);
  });

  it('attributes each property to the glob that supplied it', () => {
    const rule = resolverFor(OVERLAPPING).resolve('assets/heroes/hero.jpg');
    expect(rule.sources.maxWidth).toBe('assets/heroes/**');
    expect(rule.sources.maxBytes).toBe('assets/**/*.{jpg,jpeg,png,webp}');
    expect(rule.sources.stripMetadata).toBe('(defaults)');
  });

  it('applies defaults alone when only defaults are set', () => {
    const rule = resolverFor(`
version: 1
rules:
  "assets/**": {}
`).resolve('assets/a.jpg');
    expect(rule.matchedGlobs).toEqual(['assets/**']);
    expect(rule.body).toEqual({ upscale: false, stripMetadata: true, autoOrient: true, colorSpace: 'srgb' });
  });
});

describe('matching', () => {
  const resolver = resolverFor(OVERLAPPING);

  it('reports files matched by no rule as ungoverned', () => {
    expect(resolver.isGoverned('docs/screenshot.png')).toBe(false);
    expect(resolver.resolve('docs/screenshot.png').matchedGlobs).toEqual([]);
  });

  it('follows the platform for case sensitivity', () => {
    // Windows is case-insensitive; Linux and macOS are case-sensitive, so that
    // a repository behaves the same locally as it does in CI.
    const expected = process.platform === 'win32';
    expect(resolver.isGoverned('assets/HERO.JPG')).toBe(expected);
    expect(resolver.isGoverned('Assets/hero.jpg')).toBe(expected);
    // Exact casing always matches, on every platform.
    expect(resolver.isGoverned('assets/hero.jpg')).toBe(true);
  });

  it('does not match a governed extension outside the glob', () => {
    expect(resolver.isGoverned('assets/notes.txt')).toBe(false);
  });
});

describe('globCoversTargetFormat', () => {
  it('is true when the converted filename still matches the rule', () => {
    expect(globCoversTargetFormat('assets/**/*.{jpg,jpeg,png,webp}', 'assets/hero.png', 'webp')).toBe(true);
    expect(globCoversTargetFormat('assets/heroes/**', 'assets/heroes/hero.png', 'webp')).toBe(true);
  });

  it('is false when converting would take the file out of the rule', () => {
    expect(globCoversTargetFormat('assets/**/*.{jpg,jpeg,png}', 'assets/hero.png', 'webp')).toBe(false);
  });

  it('uses .jpg as the canonical JPEG extension', () => {
    expect(globCoversTargetFormat('assets/**/*.jpg', 'assets/hero.png', 'jpeg')).toBe(true);
    expect(globCoversTargetFormat('assets/**/*.jpeg', 'assets/hero.png', 'jpeg')).toBe(false);
  });
});
