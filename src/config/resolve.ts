import picomatch from 'picomatch';

import type { EffectiveRule, ImageFormat, Policy, RuleBody } from '../types.js';

/**
 * Rule resolution.
 *
 * ## Precedence (v0, documented and tested)
 *
 *   defaults
 *     + first matching rule
 *     + next matching rule
 *     + ...
 *     = effective rule
 *
 * Every rule whose glob matches the file is applied, in the order the globs
 * appear in the config file. Merging is SHALLOW and per-property: a later
 * matching rule overrides only the properties it actually sets. A rule that
 * sets only `format` leaves an earlier rule's `maxWidth` intact.
 *
 * This is "merge all matches, last one wins per key". It is more useful than
 * last-match-wins (you can write a broad rule and then narrow it) and it is
 * still predictable, because file order is the only thing that decides.
 * Specificity is deliberately NOT considered - it is hard to explain and
 * harder to predict.
 *
 * A file matched by no rule is ungoverned and is silently skipped.
 *
 * ## Matching
 *
 * Globs are matched against repo-relative POSIX paths, case-insensitively, so
 * `assets/**\/*.jpg` also matches `Assets/HERO.JPG` on a case-sensitive
 * filesystem. `**` crosses directory boundaries; a trailing `/**` matches
 * everything beneath a directory.
 */

const MATCH_OPTIONS: picomatch.PicomatchOptions = { dot: true, nocase: true };

/** Canonical file extension Rasterwright would use for each output format. */
export const FORMAT_EXTENSION: Record<ImageFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

const PROPERTY_KEYS = [
  'maxWidth',
  'maxHeight',
  'maxBytes',
  'format',
  'upscale',
  'stripMetadata',
  'colorSpace',
  'quality',
] as const satisfies readonly (keyof RuleBody)[];

export interface Resolver {
  /** Merge defaults and every matching rule for a repo-relative POSIX path. */
  resolve(relativePath: string): EffectiveRule;
  /** True when at least one rule glob matches. */
  isGoverned(relativePath: string): boolean;
  /** Every glob in the policy, in file order. */
  globs(): string[];
}

export function createResolver(policy: Policy): Resolver {
  const matchers = policy.rules.map((rule) => ({
    glob: rule.glob,
    body: rule.body,
    matches: picomatch(rule.glob, MATCH_OPTIONS),
  }));

  return {
    globs: () => matchers.map((m) => m.glob),

    isGoverned(relativePath) {
      return matchers.some((m) => m.matches(relativePath));
    },

    resolve(relativePath) {
      const body: RuleBody = { ...policy.defaults };
      const sources: EffectiveRule['sources'] = {};
      for (const key of PROPERTY_KEYS) {
        if (body[key] !== undefined) sources[key] = '(defaults)';
      }

      const matchedGlobs: string[] = [];
      for (const matcher of matchers) {
        if (!matcher.matches(relativePath)) continue;
        matchedGlobs.push(matcher.glob);
        for (const key of PROPERTY_KEYS) {
          const value = matcher.body[key];
          if (value === undefined) continue;
          // Shallow merge: a later matching rule replaces the value wholesale.
          (body as Record<string, unknown>)[key] = value;
          sources[key] = matcher.glob;
        }
      }

      return { body, matchedGlobs, sources };
    },
  };
}

/**
 * Would a rule's own glob still match this file after a format conversion?
 *
 * Converting `hero.png` to `hero.webp` under a glob of `assets/**\/*.{jpg,png}`
 * produces a file that no longer matches anything, so it silently leaves
 * policy. `check` reports that as a note on the file. (See 04, section 4,
 * precondition 3.)
 */
export function globCoversTargetFormat(glob: string, relativePath: string, format: ImageFormat): boolean {
  const converted = relativePath.replace(/\.[^./]+$/, `.${FORMAT_EXTENSION[format]}`);
  return picomatch.isMatch(converted, glob, MATCH_OPTIONS);
}
