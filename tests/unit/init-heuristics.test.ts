import { describe, expect, it } from 'vitest';

import { createResolver } from '../../src/config/resolve.js';
import {
  anchorsFor,
  BYTE_LADDER,
  closeRules,
  escapeGlobLiteral,
  extensionGroupFor,
  globFor,
  MAX_CLOSURE_STEPS,
  percentile,
  policyFor,
  proposeRules,
  roundUp,
  roundUpBytes,
  toleranceFor,
  verify,
  WIDTH_LADDER,
} from '../../src/init/heuristics.js';
import { parseBytes } from '../../src/utils/bytes.js';
import type { ImageInfo } from '../../src/types.js';

const GROUP = '*.{jpg,jpeg,png,webp}';

function image(path: string, overrides: Partial<ImageInfo> = {}): ImageInfo {
  return {
    path,
    bytes: 10_000,
    format: 'jpeg',
    width: 800,
    height: 600,
    storedWidth: 800,
    storedHeight: 600,
    hasAlpha: false,
    isOpaque: null,
    bitDepth: 8,
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

/** Anchor globs, which is the part of an anchor a config actually shows. */
function globs(paths: string[]): string[] {
  return anchorsFor(paths).map((anchor) => globFor(anchor, GROUP));
}

/** N paths in one directory, so a group clears the minimum size. */
function filesIn(dir: string, n: number, prefix = 'f'): string[] {
  return Array.from({ length: n }, (_, index) => `${dir === '' ? '' : `${dir}/`}${prefix}${index}.jpg`);
}

describe('percentile (nearest rank)', () => {
  it('returns the only value when there is one', () => {
    expect(percentile([1437], 90)).toBe(1437);
    expect(percentile([1437], 95)).toBe(1437);
  });

  it('picks the higher of two at p90 and p95', () => {
    expect(percentile([100, 200], 90)).toBe(200);
    expect(percentile([100, 200], 95)).toBe(200);
    expect(percentile([100, 200], 50)).toBe(100);
  });

  it('takes the ceil(p/100 * n)-th value, one-based', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 90)).toBe(90);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 10)).toBe(10);
  });

  it('never interpolates: every answer is a value that was in the set', () => {
    const values = [3, 7, 11];
    for (const p of [1, 25, 50, 75, 90, 95, 100]) expect(values).toContain(percentile(values, p));
  });

  it('does not care about input order', () => {
    expect(percentile([90, 10, 50, 70, 30], 90)).toBe(90);
  });

  it('refuses an empty set rather than inventing a number', () => {
    expect(() => percentile([], 90)).toThrow(/empty/);
  });
});

describe('ladder round-up', () => {
  it('returns a rung unchanged when the value is exactly on it', () => {
    for (const rung of WIDTH_LADDER) expect(roundUp(WIDTH_LADDER, rung)).toBe(rung);
  });

  it('rounds up to the next rung from just below and just above', () => {
    expect(roundUp(WIDTH_LADDER, 1)).toBe(640);
    expect(roundUp(WIDTH_LADDER, 639)).toBe(640);
    expect(roundUp(WIDTH_LADDER, 641)).toBe(800);
    expect(roundUp(WIDTH_LADDER, 1437)).toBe(1600);
    expect(roundUp(WIDTH_LADDER, 2401)).toBe(3000);
  });

  it('stops at the top rung rather than inventing one above it', () => {
    expect(roundUp(WIDTH_LADDER, 4000)).toBe(4000);
    expect(roundUp(WIDTH_LADDER, 99_999)).toBe(4000);
  });

  it('rounds bytes up the same way', () => {
    expect(roundUpBytes(1).label).toBe('50kb');
    expect(roundUpBytes(parseBytes('50kb', 'x')).label).toBe('50kb');
    expect(roundUpBytes(parseBytes('50kb', 'x') + 1).label).toBe('100kb');
    expect(roundUpBytes(232_361).label).toBe('300kb');
    expect(roundUpBytes(999_999_999).label).toBe('5mb');
  });

  it('writes byte rungs in a form the config parser accepts', () => {
    for (const rung of BYTE_LADDER) {
      expect(parseBytes(rung.label, 'ladder')).toBe(rung.bytes);
    }
  });

  it('keeps both ladders strictly ascending', () => {
    const ascending = (values: number[]): boolean => values.every((v, i) => i === 0 || v > values[i - 1]!);
    expect(ascending([...WIDTH_LADDER])).toBe(true);
    expect(ascending(BYTE_LADDER.map((rung) => rung.bytes))).toBe(true);
  });
});

describe('anchor selection', () => {
  it('produces nothing for an empty repository', () => {
    expect(anchorsFor([])).toEqual([]);
  });

  it('anchors one directory on itself, recursively', () => {
    expect(globs(filesIn('assets/images', 5))).toEqual([`assets/images/**/${GROUP}`]);
  });

  it('anchors root-level images non-recursively', () => {
    expect(globs(filesIn('', 4))).toEqual([GROUP]);
  });

  it('absorbs a nested directory into its ancestor', () => {
    const paths = [...filesIn('assets/images', 5), ...filesIn('assets/images/placeholders', 4, 'p')];
    const anchors = anchorsFor(paths);
    expect(anchors.map((anchor) => globFor(anchor, GROUP))).toEqual([`assets/images/**/${GROUP}`]);
    expect(anchors[0]?.files).toHaveLength(9);
  });

  it('drops a group of fewer than three images when a larger one survives', () => {
    const paths = [...filesIn('assets/images', 6), ...filesIn('docs', 2, 'd')];
    expect(globs(paths)).toEqual([`assets/images/**/${GROUP}`]);
  });

  it('keeps small groups when dropping them would leave nothing governed', () => {
    expect(globs([...filesIn('a', 1), ...filesIn('b', 1)])).toEqual([`a/**/${GROUP}`, `b/**/${GROUP}`]);
  });

  it('keeps up to three separate anchors', () => {
    const paths = [...filesIn('a', 3), ...filesIn('b', 3), ...filesIn('c', 3)];
    expect(globs(paths)).toEqual([`a/**/${GROUP}`, `b/**/${GROUP}`, `c/**/${GROUP}`]);
  });

  it('rolls the deepest anchor up to its parent when there would be four', () => {
    const paths = [
      ...filesIn('src/a', 3),
      ...filesIn('src/b', 3),
      ...filesIn('assets', 3),
      ...filesIn('docs', 3),
    ];
    // src/a and src/b roll up into src, leaving three anchors.
    expect(globs(paths)).toEqual([`assets/**/${GROUP}`, `docs/**/${GROUP}`, `src/**/${GROUP}`]);
  });

  it('breaks a tie in depth by taking the lexicographically last directory', () => {
    const paths = [...filesIn('x/a', 3), ...filesIn('x/b', 3), ...filesIn('y/c', 3), ...filesIn('y/d', 3)];
    // y/d rolls up to y, which absorbs y/c, leaving x/a, x/b and y.
    expect(globs(paths)).toEqual([`x/a/**/${GROUP}`, `x/b/**/${GROUP}`, `y/**/${GROUP}`]);
  });

  it('collapses to one broad rule when a roll-up reaches the project root', () => {
    const paths = [...filesIn('a', 3), ...filesIn('b', 3), ...filesIn('c', 3), ...filesIn('d', 3)];
    const anchors = anchorsFor(paths);
    expect(anchors.map((anchor) => globFor(anchor, GROUP))).toEqual([`**/${GROUP}`]);
    expect(anchors[0]?.files).toHaveLength(12);
  });

  it('is deterministic regardless of the order paths arrive in', () => {
    const paths = [...filesIn('src/a', 3), ...filesIn('src/b', 3), ...filesIn('assets', 3), ...filesIn('docs', 3)];
    expect(globs([...paths].reverse())).toEqual(globs(paths));
  });

  it('governs every file it claims to: each anchor path matches its own glob', () => {
    const paths = [...filesIn('assets/images', 5), ...filesIn('assets/images/placeholders', 4, 'p')];
    for (const anchor of anchorsFor(paths)) {
      expect(governedByOwnGlob(anchor.files, globFor(anchor, GROUP))).toEqual(anchor.files);
    }
  });
});

/** Which of `files` the real resolver considers governed by a single-rule policy. */
function governedByOwnGlob(files: readonly string[], glob: string): string[] {
  const resolver = createResolver(
    policyFor([{ glob, maxWidth: 800, maxBytes: BYTE_LADDER[0]!, files: [], stats: EMPTY_STATS }]),
  );
  return files.filter((file) => resolver.isGoverned(file));
}

const EMPTY_STATS = { measured: 0, widestSeen: 0, p90Width: 0, largestSeen: 0, p95Bytes: 0 };

describe('directory names that are also glob syntax', () => {
  // A directory really can be called any of these. Interpolated raw, each one
  // produces a rule that governs nothing while looking like it governs a lot.
  const NAMES = [
    'img (old)',
    'a(b',
    '{a,b}',
    'a\\b',
    'say "hi"',
    '[a]',
    'plus+x',
    '@scope',
    '!neg',
    'uni café',
    'a#b',
    'star*x',
    'q?x',
    'pipe|x',
  ];

  it.each(NAMES)('governs the files under %j', (name) => {
    const files = [`${name}/hero.jpg`, `${name}/sub/deep.png`, `${name}/a b.webp`];
    const anchors = anchorsFor(files);

    expect(anchors).toHaveLength(1);
    expect(governedByOwnGlob(files, globFor(anchors[0]!, GROUP))).toEqual(files);
  });

  it.each(NAMES)('does not accidentally govern a sibling directory next to %j', (name) => {
    const files = [`${name}/hero.jpg`, `${name}/b.png`, `${name}/c.webp`];
    const glob = globFor(anchorsFor(files)[0]!, GROUP);

    expect(governedByOwnGlob(['unrelated/hero.jpg', 'x/y/hero.jpg'], glob)).toEqual([]);
  });

  it('escapes only pattern characters, leaving the path separator alone', () => {
    const files = ['a(b/c[d]/one.jpg', 'a(b/c[d]/two.jpg', 'a(b/c[d]/three.jpg'];
    const glob = globFor(anchorsFor(files)[0]!, GROUP);

    expect(glob).toBe('a\\(b/c\\[d\\]/**/*.{jpg,jpeg,png,webp}');
    expect(governedByOwnGlob(files, glob)).toEqual(files);
  });

  it('leaves a plain directory name untouched', () => {
    expect(escapeGlobLiteral('assets/src/images')).toBe('assets/src/images');
  });
});

describe('extension spellings', () => {
  it('is the four lowercase spellings when that is all the scan saw', () => {
    expect(extensionGroupFor(['a/one.jpg', 'a/two.png'])).toBe('*.{jpg,jpeg,png,webp}');
    expect(extensionGroupFor([])).toBe('*.{jpg,jpeg,png,webp}');
  });

  it('adds an uppercase spelling that actually exists', () => {
    expect(extensionGroupFor(['a/x1.JPG', 'a/x2.png'])).toBe('*.{jpg,jpeg,png,webp,JPG}');
  });

  it('adds every distinct spelling seen, sorted, and no others', () => {
    const group = extensionGroupFor(['a/x.JPG', 'a/y.Png', 'a/z.JPG', 'a/w.webp']);
    expect(group).toBe('*.{jpg,jpeg,png,webp,JPG,Png}');
  });

  it('ignores extensions Rasterwright does not support', () => {
    expect(extensionGroupFor(['a/x.SVG', 'a/y.TIFF'])).toBe('*.{jpg,jpeg,png,webp}');
  });

  it('governs an uppercase file, which a lowercase-only group would not', () => {
    const files = ['a/x1.JPG', 'a/x2.png', 'a/x3.webp'];
    const anchor = anchorsFor(files)[0]!;

    expect(governedByOwnGlob(files, globFor(anchor, GROUP))).not.toContain('a/x1.JPG');
    expect(governedByOwnGlob(files, globFor(anchor, extensionGroupFor(files)))).toEqual(files);
  });
});

describe('proposeRules', () => {
  it('takes maxWidth from the 90th percentile and maxBytes from the 95th', () => {
    const paths = filesIn('assets', 10);
    const infos = new Map(
      paths.map((path, index) => [path, image(path, { width: (index + 1) * 100, bytes: (index + 1) * 20_000 })]),
    );
    const [rule] = proposeRules(anchorsFor(paths), infos);

    expect(rule?.stats.p90Width).toBe(900);
    expect(rule?.maxWidth).toBe(1000);
    expect(rule?.stats.p95Bytes).toBe(200_000);
    expect(rule?.maxBytes.label).toBe('200kb');
  });

  it('reports the widest and largest actually seen, not the percentile', () => {
    const paths = filesIn('assets', 4);
    const infos = new Map(
      paths.map((path, index) => [path, image(path, { width: index === 3 ? 4000 : 100, bytes: 1000 })]),
    );
    const [rule] = proposeRules(anchorsFor(paths), infos);
    expect(rule?.stats.widestSeen).toBe(4000);
    expect(rule?.stats.measured).toBe(4);
  });

  it('ignores files that could not be measured', () => {
    const paths = filesIn('assets', 4);
    const infos = new Map(paths.slice(0, 3).map((path) => [path, image(path, { width: 500, bytes: 1000 })]));
    const [rule] = proposeRules(anchorsFor(paths), infos);
    expect(rule?.stats.measured).toBe(3);
    expect(rule?.maxWidth).toBe(640);
  });

  it('emits no rule for a group where nothing could be measured', () => {
    expect(proposeRules(anchorsFor(filesIn('assets', 4)), new Map())).toEqual([]);
  });

  it('sets only maxWidth and maxBytes, never format or maxHeight', () => {
    const paths = filesIn('assets', 3);
    const infos = new Map(paths.map((path) => [path, image(path)]));
    const policy = policyFor(proposeRules(anchorsFor(paths), infos));
    for (const rule of policy.rules) {
      expect(Object.keys(rule.body).sort()).toEqual(['maxBytes', 'maxWidth']);
    }
  });
});

describe('verification against the real evaluator', () => {
  it('counts errors and warnings the way check counts them', () => {
    const paths = filesIn('assets', 3);
    const infos = [
      image(paths[0]!, { width: 5000, bytes: 1000 }),
      image(paths[1]!, { width: 100, bytes: 1000, hasExif: true }),
      image(paths[2]!, { width: 100, bytes: 1000 }),
    ];
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));
    // Force a limit the widest file cannot meet.
    rules[0]!.maxWidth = 640;

    const verification = verify(rules, infos);
    expect(verification.errors).toBe(1);
    expect(verification.warnings).toBe(1);
    expect(verification.filesWithErrors).toBe(1);
    expect(verification.perRule.get(rules[0]!.glob)?.widthOver).toBe(1);
  });

  it('counts an unreadable governed image as one error, like check does', () => {
    const paths = filesIn('assets', 3);
    const infos = paths.map((path) => image(path, { width: 100, bytes: 1000 }));
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));

    expect(verify(rules, infos, { unreadable: ['assets/broken.jpg'] }).errors).toBe(1);
  });

  it('does not count an unreadable image no rule governs', () => {
    const paths = filesIn('assets', 3);
    const infos = paths.map((path) => image(path, { width: 100, bytes: 1000 }));
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));

    const verification = verify(rules, infos, { unreadable: ['elsewhere/broken.jpg'] });
    expect(verification.errors).toBe(0);
    expect(verification.ungoverned).toEqual(['elsewhere/broken.jpg']);
  });

  it('reports files no generated rule matches', () => {
    const governed = filesIn('assets', 3);
    const infos = [...governed, 'docs/stray.jpg'].map((path) => image(path, { width: 100, bytes: 1000 }));
    const rules = proposeRules(anchorsFor([...governed, 'docs/stray.jpg']), new Map(infos.map((i) => [i.path, i])));

    expect(verify(rules, infos).ungoverned).toEqual(['docs/stray.jpg']);
  });
});

describe('closure loop', () => {
  it('leaves a rule alone when few enough files are over its limits', () => {
    const paths = filesIn('assets', 20);
    const infos = paths.map((path, index) => image(path, { width: index === 0 ? 3000 : 100, bytes: 1000 }));
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));
    const before = rules[0]!.maxWidth;

    const closed = closeRules(rules, infos);
    expect(closed.steps).toBe(0);
    expect(closed.rules[0]?.maxWidth).toBe(before);
  });

  it('climbs the width ladder until the tolerance is met', () => {
    // A hundred files, ten of them wide. p90 lands on the ninetieth value, which
    // is a small one, so all ten are over the limit the ladder first produces -
    // more than max(3, 5% of 100) = 5, so the rule has to loosen.
    const paths = filesIn('assets', 100);
    const infos = paths.map((path, index) => image(path, { width: index < 10 ? 2400 : 100, bytes: 1000 }));
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));
    expect(rules[0]!.maxWidth).toBe(640);

    const closed = closeRules(rules, infos);
    expect(closed.steps).toBeGreaterThan(0);
    expect(closed.rules[0]!.maxWidth).toBe(2400);
    expect(verify(closed.rules, infos).perRule.get(closed.rules[0]!.glob)?.overLimit).toBe(0);
  });

  it('climbs the byte ladder when bytes are what is failing', () => {
    // p95 plus a 5% tolerance means a freshly proposed byte limit is already
    // inside tolerance, so this branch is reached only when something else set
    // the limit: a width ladder that has topped out, or an edited rule.
    const paths = filesIn('assets', 100);
    const infos = paths.map((path) => image(path, { width: 100, bytes: 400_000 }));
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));
    rules[0]!.maxBytes = BYTE_LADDER[0]!;
    const startWidth = rules[0]!.maxWidth;

    const closed = closeRules(rules, infos);
    expect(closed.steps).toBeGreaterThan(0);
    expect(closed.rules[0]!.maxWidth).toBe(startWidth);
    expect(closed.rules[0]!.maxBytes.bytes).toBeGreaterThanOrEqual(400_000);
  });

  it('falls through to bytes when the width ladder has topped out', () => {
    const paths = filesIn('assets', 100);
    const infos = paths.map((path) => image(path, { width: 9000, bytes: 400_000 }));
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));
    rules[0]!.maxBytes = BYTE_LADDER[0]!;
    // Every file is wider than the top rung, so width has nowhere left to go.
    expect(rules[0]!.maxWidth).toBe(WIDTH_LADDER[WIDTH_LADDER.length - 1]);

    const closed = closeRules(rules, infos);
    expect(closed.rules[0]!.maxBytes.bytes).toBeGreaterThan(BYTE_LADDER[0]!.bytes);
  });

  it('ignores an extension mismatch: no ceiling can move it', () => {
    // Every file is a WebP under a .jpg name, which is an error on every one of
    // them. A loop that reacted to error counts alone would climb to the top.
    const paths = filesIn('assets', 20);
    const infos = paths.map((path) => image(path, { format: 'webp', width: 100, bytes: 1000 }));
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));

    const closed = closeRules(rules, infos);
    expect(closed.steps).toBe(0);
    expect(closed.rules[0]!.maxWidth).toBe(640);
    expect(verify(closed.rules, infos).errors).toBe(20);
  });

  it('ignores a metadata warning', () => {
    const paths = filesIn('assets', 20);
    const infos = paths.map((path) => image(path, { width: 100, bytes: 1000, hasExif: true }));
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));

    expect(closeRules(rules, infos).steps).toBe(0);
  });

  it('stops at the step cap rather than looping on an unsatisfiable corpus', () => {
    const paths = filesIn('assets', 20);
    const infos = paths.map((path) => image(path, { width: 100, bytes: 20_000_000 }));
    const rules = proposeRules(anchorsFor(paths), new Map(infos.map((info) => [info.path, info])));

    const closed = closeRules(rules, infos);
    expect(closed.steps).toBeLessThanOrEqual(MAX_CLOSURE_STEPS);
    // Both ladders top out, so the numbers stay honest and the summary says how
    // many files the config flags.
    expect(closed.rules[0]!.maxBytes.label).toBe('5mb');
  });

  it('bumps every rule independently', () => {
    const a = filesIn('a', 100);
    const b = filesIn('b', 100, 'g');
    const infos = [
      ...a.map((path, index) => image(path, { width: index < 10 ? 2400 : 100, bytes: 1000 })),
      ...b.map((path) => image(path, { width: 100, bytes: 1000 })),
    ];
    const rules = proposeRules(anchorsFor([...a, ...b]), new Map(infos.map((info) => [info.path, info])));
    const bBefore = rules.find((rule) => rule.glob.startsWith('b/'))!.maxWidth;

    const closed = closeRules(rules, infos);
    expect(closed.rules.find((rule) => rule.glob.startsWith('a/'))!.maxWidth).toBeGreaterThanOrEqual(2400);
    expect(closed.rules.find((rule) => rule.glob.startsWith('b/'))!.maxWidth).toBe(bBefore);
  });
});

describe('tolerance', () => {
  it('is three files, or five percent, whichever is larger', () => {
    expect(toleranceFor(0)).toBe(3);
    expect(toleranceFor(20)).toBe(3);
    expect(toleranceFor(60)).toBe(3);
    expect(toleranceFor(61)).toBe(4);
    expect(toleranceFor(1000)).toBe(50);
  });
});
