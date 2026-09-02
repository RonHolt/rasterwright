import { describe, expect, it } from 'vitest';

import { createResolver } from '../../src/config/resolve.js';
import { evaluate } from '../../src/policy/evaluate.js';
import { planFile } from '../../src/operations/plan.js';
import type {
  EffectiveRule,
  EncodeOperation,
  FilePlan,
  FileResult,
  Finding,
  FixPermissions,
  ImageInfo,
  PlannedOperation,
  Policy,
  RuleBody,
} from '../../src/types.js';

/**
 * The planner is pure, so these tests never touch an image file. They build an
 * `ImageInfo`, run the real policy evaluation over it, and assert on the plan.
 *
 * Running evaluation rather than hand-writing findings is deliberate: the
 * planner's contract is with what `check` actually produces, and a test that
 * invents findings would keep passing after the two drifted apart.
 */

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

const NO_PERMISSIONS: FixPermissions = { allowRenames: false };
const ALLOW_RENAMES: FixPermissions = { allowRenames: true };

function rule(body: RuleBody, matchedGlobs = ['assets/**']): EffectiveRule {
  const sources: EffectiveRule['sources'] = {};
  for (const key of Object.keys(body) as (keyof RuleBody)[]) sources[key] = matchedGlobs[0] ?? '(defaults)';
  return { body, matchedGlobs, sources };
}

/** The full pipeline for one file: evaluate, then plan. */
function plan(info: ImageInfo, body: RuleBody, permissions = NO_PERMISSIONS, globs?: string[]): FilePlan {
  return planFile(evaluate(info, rule(body, globs)), permissions);
}

function ops(planned: FilePlan): PlannedOperation['op'][] {
  return planned.operations.map((operation) => operation.op);
}

function encodeIn(planned: FilePlan): EncodeOperation {
  const found = [...planned.operations, ...planned.blockedOperations].find((o) => o.op === 'encode');
  if (found === undefined) throw new Error(`no encode operation in plan for ${planned.path}`);
  return found;
}

describe('already compliant', () => {
  it('plans nothing at all', () => {
    const result = plan(image(), { maxWidth: 2400, maxBytes: 500_000, stripMetadata: true });
    expect(result.status).toBe('unchanged');
    expect(result.operations).toEqual([]);
    expect(result.targetPath).toBe('assets/hero.jpg');
    expect(result.requiresVerification).toBe(false);
  });

  it('leaves a compliant file alone even under a byte ceiling it is far below', () => {
    // maxBytes is a ceiling, not a target. Nothing grows a file to use it up.
    const result = plan(image({ bytes: 1_000 }), { maxBytes: 500_000 });
    expect(result.status).toBe('unchanged');
    expect(result.operations).toEqual([]);
  });
});

describe('resize', () => {
  it('plans exactly one resize, rounded down, inside the limit', () => {
    const result = plan(image({ width: 2560, height: 1001 }), { maxWidth: 2400 });

    expect(result.status).toBe('planned');
    expect(result.operations[0]).toEqual({
      op: 'resize',
      from: { width: 2560, height: 1001 },
      to: { width: 2400, height: 938 },
      maxWidth: 2400,
      fit: 'inside',
      upscale: false,
    });
    expect(result.resolves).toEqual(['maxWidth']);
  });

  it('never produces dimensions over the policy limits', () => {
    // Round *down*, always. A single pixel over maxWidth means the next run
    // finds the same violation and resizes again, and fix is not idempotent.
    for (let width = 2401; width < 2600; width += 1) {
      const resize = plan(image({ width, height: 1001 }), { maxWidth: 2400 }).operations[0];
      if (resize?.op !== 'resize') throw new Error('expected a resize');
      expect(resize.to.width).toBeLessThanOrEqual(2400);
      expect(resize.to.height).toBeLessThanOrEqual(1001);
    }
  });

  it('honours whichever of maxWidth and maxHeight binds harder', () => {
    const result = plan(image({ width: 2000, height: 3000 }), { maxWidth: 1000, maxHeight: 600 });
    const resize = result.operations[0];
    if (resize?.op !== 'resize') throw new Error('expected a resize');
    // Height is the binding constraint: 600/3000 is a tighter ratio than 1000/2000.
    expect(resize.to).toEqual({ width: 400, height: 600 });
    expect(resize.maxWidth).toBe(1000);
    expect(resize.maxHeight).toBe(600);
  });

  it('resizes once for a file that breaks both dimension limits', () => {
    const result = plan(image({ width: 4000, height: 4000 }), { maxWidth: 1000, maxHeight: 1000 });
    expect(ops(result).filter((op) => op === 'resize')).toHaveLength(1);
  });

  it('re-encodes as part of the resize, because pixels cannot be resized in place', () => {
    const result = plan(image({ width: 2560, height: 1001 }), { maxWidth: 2400 });
    expect(ops(result)).toEqual(['resize', 'encode']);
    expect(encodeIn(result).budgetDriven).toBe(false);
  });
});

describe('maxBytes', () => {
  it('plans an encode toward the ceiling and claims no result', () => {
    const result = plan(image({ bytes: 800_000 }), { maxBytes: 500_000 });

    expect(ops(result)).toEqual(['encode']);
    expect(encodeIn(result)).toMatchObject({
      format: 'jpeg',
      maxBytes: 500_000,
      budgetDriven: true,
      outcomeRequiresVerification: true,
    });
    expect(result.requiresVerification).toBe(true);
  });

  it('does not predict an output size anywhere in the plan', () => {
    // Planning has not encoded anything. The only honest statements it can make
    // are the target and the fact that the result has to be measured.
    const result = plan(image({ bytes: 800_000 }), { maxBytes: 500_000 });
    const encode = encodeIn(result);
    expect(Object.keys(encode)).not.toContain('expectedBytes');
    expect(Object.keys(encode)).not.toContain('estimatedBytes');
  });

  it('carries the quality band for a lossy target', () => {
    const result = plan(image({ bytes: 800_000 }), { maxBytes: 500_000, quality: { start: 90, floor: 60 } });
    expect(encodeIn(result).quality).toEqual({ start: 90, floor: 60 });
  });

  it('gives PNG no quality dial and says the ceiling may be unreachable', () => {
    const png = image({ path: 'assets/shot.png', format: 'png', bytes: 800_000 });
    const result = plan(png, { maxBytes: 500_000 });

    const encode = encodeIn(result);
    expect(encode.format).toBe('png');
    expect(encode.quality).toBeUndefined();
    expect(encode.lossyReencode).toBe(false);
    expect(result.notes.join(' ')).toMatch(/PNG is lossless/);
  });

  it('marks a lossy source re-encoded in a lossy format as generation loss', () => {
    const webp = image({ path: 'assets/a.webp', format: 'webp', bytes: 800_000 });
    expect(encodeIn(plan(webp, { maxBytes: 500_000, format: 'webp' })).lossyReencode).toBe(true);
  });
});

describe('resize and maxBytes together', () => {
  it('resizes first, then encodes exactly once', () => {
    const result = plan(image({ width: 4000, bytes: 4_000_000 }), { maxWidth: 2400, maxBytes: 400_000 });

    expect(ops(result)).toEqual(['resize', 'encode']);
    expect(result.resolves).toEqual(['maxWidth', 'maxBytes']);
    expect(encodeIn(result)).toMatchObject({ maxBytes: 400_000, budgetDriven: true });
  });
});

describe('format conversion', () => {
  const jpeg = image({ path: 'assets/hero.jpg', width: 4000, bytes: 4_000_000 });
  const body: RuleBody = { maxWidth: 2400, maxBytes: 400_000, format: 'webp', stripMetadata: true };

  it('is blocked without rename permission, and plans nothing at all', () => {
    const result = plan(jpeg, body);

    expect(result.status).toBe('requires-permission');
    expect(result.operations).toEqual([]);
    expect(result.requiredPermissions).toEqual(['allowRenames']);
    expect(result.unresolved).toEqual(['maxWidth', 'maxBytes', 'format']);
    expect(result.targetPath).toBe('assets/hero.webp');
  });

  it('reports the plan permission would unlock, without executing it', () => {
    const result = plan(jpeg, body);
    expect(result.blockedOperations.map((operation) => operation.op)).toEqual(['resize', 'encode', 'rename']);
  });

  it('produces one coherent rewrite with permission', () => {
    const result = plan(jpeg, body, ALLOW_RENAMES);

    expect(result.status).toBe('planned');
    expect(ops(result)).toEqual(['resize', 'encode', 'rename']);
    expect(result.targetPath).toBe('assets/hero.webp');
    expect(encodeIn(result)).toMatchObject({ format: 'webp', maxBytes: 400_000 });
    expect(result.operations.at(-1)).toEqual({
      op: 'rename',
      from: 'assets/hero.jpg',
      to: 'assets/hero.webp',
      reason: 'format-conversion',
      reencode: true,
    });
  });

  it('converts a file that breaks no other rule with a single encode', () => {
    const result = plan(image(), { format: 'webp' }, ALLOW_RENAMES);
    expect(ops(result)).toEqual(['encode', 'rename']);
  });

  it('leaves a transparent PNG under a JPEG rule unfixable', () => {
    // JPEG cannot represent an alpha channel and Rasterwright will not invent a
    // background colour. Permission does not change that.
    const logo = image({ path: 'assets/logo.png', format: 'png', hasAlpha: true, isOpaque: false });

    for (const permissions of [NO_PERMISSIONS, ALLOW_RENAMES]) {
      const result = plan(logo, { format: 'jpeg' }, permissions);
      expect(result.status).toBe('unfixable');
      expect(result.operations).toEqual([]);
      expect(result.blockedOperations).toEqual([]);
      expect(result.reasons.join(' ')).toMatch(/JPEG cannot represent it/);
    }
  });

  it('converts a PNG whose alpha channel is provably unused', () => {
    const opaque = image({ path: 'assets/flat.png', format: 'png', hasAlpha: true, isOpaque: true });
    const result = plan(opaque, { format: 'jpeg' }, ALLOW_RENAMES);

    expect(result.status).toBe('planned');
    expect(encodeIn(result).preserveAlpha).toBe(false);
  });

  it('keeps transparency across a conversion that can carry it', () => {
    const logo = image({ path: 'assets/logo.png', format: 'png', hasAlpha: true, isOpaque: false });
    expect(encodeIn(plan(logo, { format: 'webp' }, ALLOW_RENAMES)).preserveAlpha).toBe(true);
  });

  it('notes when the converted file would fall out of its own rule', () => {
    // `assets/**/*.png` cannot match hero.webp, so the output silently leaves
    // policy. check reports it; a plan about to cause it repeats it.
    const png = image({ path: 'assets/hero.png', format: 'png' });
    const result = plan(png, { format: 'webp' }, ALLOW_RENAMES, ['assets/**/*.png']);
    expect(result.notes.join(' ')).toMatch(/no longer match any rule/);
  });
});

describe('extension correction', () => {
  /** A .png whose bytes are really WebP. Taken from a real theme. */
  const mislabelled = image({ path: 'assets/logo.png', format: 'webp', hasAlpha: true, isOpaque: false });

  it('requires permission, because a rename can break references', () => {
    const result = plan(mislabelled, { maxWidth: 2400 });

    expect(result.status).toBe('requires-permission');
    expect(result.operations).toEqual([]);
    expect(result.requiredPermissions).toEqual(['allowRenames']);
    expect(result.targetPath).toBe('assets/logo.webp');
  });

  it('is rename-only with permission: no encode, no pixel work', () => {
    const result = plan(mislabelled, { maxWidth: 2400 }, ALLOW_RENAMES);

    expect(result.status).toBe('planned');
    expect(result.operations).toEqual([
      {
        op: 'rename',
        from: 'assets/logo.png',
        to: 'assets/logo.webp',
        reason: 'extension-correction',
        reencode: false,
      },
    ]);
    expect(result.requiresVerification).toBe(false);
    expect(result.resolves).toEqual(['extension']);
  });

  it('does not rewrite pixels to fix a filename', () => {
    // Decoding and re-encoding a perfectly good WebP to correct its extension
    // would be pure generation loss for a text change.
    const result = plan(mislabelled, { maxWidth: 2400 }, ALLOW_RENAMES);
    expect(ops(result)).not.toContain('encode');
  });

  it('leaves .jpeg alone: it is an alias, not a mismatch', () => {
    const aliased = image({ path: 'assets/photo.jpeg' });
    expect(plan(aliased, { format: 'jpeg' }, ALLOW_RENAMES).status).toBe('unchanged');
    expect(plan(aliased, { maxWidth: 2400 }, ALLOW_RENAMES).targetPath).toBe('assets/photo.jpeg');
  });

  it('needs no rename when the policy converts the contents back to the extension', () => {
    // logo.png holding WebP under `format: png`: re-encoding to PNG makes the
    // existing filename correct, so nothing is renamed and nothing is blocked.
    const result = plan(mislabelled, { format: 'png' });

    expect(result.status).toBe('planned');
    expect(ops(result)).toEqual(['encode']);
    expect(result.targetPath).toBe('assets/logo.png');
    expect(result.resolves).toEqual(['extension', 'format']);
  });
});

describe('a blocked rename blocks the whole file', () => {
  const oversizedAndMislabelled = image({
    path: 'assets/logo.png',
    format: 'webp',
    width: 4000,
    height: 3000,
  });

  it('plans no other operation on the file', () => {
    const result = plan(oversizedAndMislabelled, { maxWidth: 2400 });

    expect(result.status).toBe('requires-permission');
    expect(result.operations).toEqual([]);
    expect(ops(result)).not.toContain('resize');
    expect(result.unresolved).toEqual(expect.arrayContaining(['maxWidth', 'extension']));
  });

  it('plans resize, encode and rename in that order once permitted', () => {
    // The resize output is already WebP, so it is written as WebP and then
    // renamed. Nothing is renamed first and reopened.
    const result = plan(oversizedAndMislabelled, { maxWidth: 2400 }, ALLOW_RENAMES);

    expect(ops(result)).toEqual(['resize', 'encode', 'rename']);
    expect(encodeIn(result).format).toBe('webp');
    expect(result.operations.at(-1)).toMatchObject({
      op: 'rename',
      to: 'assets/logo.webp',
      reason: 'extension-correction',
      reencode: true,
    });
  });
});

describe('metadata', () => {
  const withExif = { hasExif: true };

  it('is never a reason to rewrite a file on its own', () => {
    const result = plan(image(withExif), { maxWidth: 2400, stripMetadata: true });

    expect(result.status).toBe('unchanged');
    expect(result.operations).toEqual([]);
    expect(result.warnings).toEqual(['metadata']);
    expect(result.normalizedDuringRewrite).toEqual([]);
  });

  it('is stripped during a rewrite some error already required', () => {
    const result = plan(image({ ...withExif, width: 4000 }), { maxWidth: 2400, stripMetadata: true });

    expect(result.normalizedDuringRewrite).toEqual(['metadata']);
    expect(encodeIn(result).stripMetadata).toBe(true);
  });

  it('is kept when the policy says to keep it', () => {
    const result = plan(image({ ...withExif, width: 4000 }), { maxWidth: 2400, stripMetadata: false });

    expect(result.normalizedDuringRewrite).toEqual([]);
    expect(encodeIn(result).stripMetadata).toBe(false);
  });

  it('is not normalized by a rename that rewrites no pixels', () => {
    const mislabelled = image({ path: 'assets/logo.png', format: 'webp', ...withExif });
    const result = plan(mislabelled, { stripMetadata: true }, ALLOW_RENAMES);

    expect(ops(result)).toEqual(['rename']);
    expect(result.normalizedDuringRewrite).toEqual([]);
  });
});

describe('orientation', () => {
  const rotated = image({ orientation: 6, storedWidth: 600, storedHeight: 400, width: 400, height: 600 });

  it('plans an auto-orient first when autoOrient is on', () => {
    const result = plan(rotated, { autoOrient: true });

    expect(ops(result)).toEqual(['autoOrient', 'encode']);
    expect(result.operations[0]).toEqual({
      op: 'autoOrient',
      orientation: 6,
      from: { width: 600, height: 400 },
      to: { width: 400, height: 600 },
    });
  });

  it('plans nothing when autoOrient is off', () => {
    expect(plan(rotated, { autoOrient: false }).status).toBe('unchanged');
  });

  it('orients before resizing, because orientation decides the dimensions', () => {
    const result = plan(rotated, { autoOrient: true, maxWidth: 300 });
    expect(ops(result)).toEqual(['autoOrient', 'resize', 'encode']);

    const resize = result.operations[1];
    if (resize?.op !== 'resize') throw new Error('expected a resize');
    // Displayed dimensions, i.e. post-orientation, are what maxWidth governs.
    expect(resize.from).toEqual({ width: 400, height: 600 });
    expect(resize.to).toEqual({ width: 300, height: 450 });
  });
});

/**
 * The case that makes `autoOrient: false` dangerous rather than merely quiet.
 *
 * Nothing about the flag is a finding here, so no `autoOrient` operation is
 * planned. But an encoder drops metadata by default, so a rewrite that some
 * *other* error demanded would clear the flag and leave the pixels unrotated,
 * and the image would start displaying sideways. The planner has to say the
 * flag is being carried through, otherwise the dry run is not a description of
 * the run.
 */
describe('orientation preserved through a rewrite it did not ask for', () => {
  const rotated = image({ orientation: 6, storedWidth: 600, storedHeight: 400, width: 400, height: 600 });

  it('sets the flag on the encode when another error forces a rewrite', () => {
    const result = plan(rotated, { autoOrient: false, maxWidth: 300 });

    expect(ops(result)).toEqual(['resize', 'encode']);
    expect(encodeIn(result).preservesOrientation).toBe(true);
  });

  it('says so in a note, including that EXIF will remain', () => {
    const note = plan(rotated, { autoOrient: false, maxWidth: 300 }).notes.join(' ');
    expect(note).toMatch(/orientation 6 is preserved/);
    expect(note).toMatch(/minimal EXIF block/);
    expect(note).toMatch(/metadata warning/);
  });

  it('does not set it when the flag is being applied to the pixels instead', () => {
    const result = plan(rotated, { autoOrient: true, maxWidth: 300 });
    expect(ops(result)).toEqual(['autoOrient', 'resize', 'encode']);
    expect(encodeIn(result).preservesOrientation).toBe(false);
    expect(result.notes).toEqual([]);
  });

  it('does not set it on an image whose flag is already normal', () => {
    const result = plan(image({ width: 4000 }), { autoOrient: false, maxWidth: 300 });
    expect(encodeIn(result).preservesOrientation).toBe(false);
  });

  it('plans no rewrite at all when nothing else is wrong', () => {
    const result = plan(rotated, { autoOrient: false });
    expect(result.status).toBe('unchanged');
    expect(result.operations).toEqual([]);
  });

  it('carries the flag through a format conversion as well', () => {
    const result = plan(rotated, { autoOrient: false, format: 'webp' }, ALLOW_RENAMES);
    expect(ops(result)).toEqual(['encode', 'rename']);
    expect(encodeIn(result).preservesOrientation).toBe(true);
  });
});

describe('colour space', () => {
  it('converts a confidently non-sRGB image', () => {
    const cmyk = image({ pixelColorSpace: 'cmyk', colorSpaceStatus: 'non-srgb' });
    const result = plan(cmyk, { colorSpace: 'srgb' });

    expect(ops(result)).toEqual(['toColorSpace', 'encode']);
    expect(result.operations[0]).toEqual({ op: 'toColorSpace', space: 'srgb', from: 'cmyk' });
  });

  it('invents no conversion for a profile it could not identify', () => {
    // An unidentifiable profile is an info finding, never an error. Converting
    // on a guess is how a tool quietly wrecks colour.
    const unknown = image({
      colorSpaceStatus: 'unknown',
      hasIccProfile: true,
      iccDescription: 'Some Vendor Profile',
    });
    const result = plan(unknown, { colorSpace: 'srgb' });

    expect(result.status).toBe('unchanged');
    expect(result.operations).toEqual([]);
  });

  it('runs after geometry and before the encoder', () => {
    const cmyk = image({ width: 4000, pixelColorSpace: 'cmyk', colorSpaceStatus: 'non-srgb', orientation: 6 });
    expect(ops(plan(cmyk, { colorSpace: 'srgb', maxWidth: 2400, autoOrient: true }))).toEqual([
      'autoOrient',
      'resize',
      'toColorSpace',
      'encode',
    ]);
  });
});

describe('images v0 will not touch', () => {
  it('reports an animated image as unsupported rather than planning around it', () => {
    const animated = image({ path: 'assets/loop.webp', format: 'webp', isAnimated: true, width: 4000 });
    const result = plan(animated, { maxWidth: 2400 });

    expect(result.status).toBe('unsupported');
    expect(result.operations).toEqual([]);
    expect(result.reasons.join(' ')).toMatch(/animated/);
    expect(result.unresolved).toContain('maxWidth');
  });

  it('leaves a compliant animated image unchanged rather than unsupported', () => {
    const animated = image({ path: 'assets/loop.webp', format: 'webp', isAnimated: true });
    expect(plan(animated, { maxWidth: 2400 }).status).toBe('unchanged');
  });

  it('cannot fix an image it could not decode', () => {
    const unreadable: FileResult = {
      path: 'assets/broken.jpg',
      status: 'error',
      matchedGlobs: ['assets/**'],
      findings: [
        {
          path: 'assets/broken.jpg',
          rule: '(built-in)',
          check: 'decode',
          severity: 'error',
          actual: null,
          allowed: null,
          fixable: 'no',
          message: 'could not decode image: unsupported image format',
        } satisfies Finding,
      ],
      fixable: 'no',
      error: 'could not decode image: unsupported image format',
    };

    const result = planFile(unreadable, ALLOW_RENAMES);
    expect(result.status).toBe('unfixable');
    expect(result.operations).toEqual([]);
    expect(result.reasons.join(' ')).toMatch(/could not decode/);
  });
});

describe('a 16-bit source is never re-encoded', () => {
  const deep = image({ path: 'assets/deep.png', format: 'png', width: 1600, height: 900, bitDepth: 16 });

  it('is unsupported rather than resized down to 8 bits', () => {
    const result = plan(deep, { maxWidth: 800 });

    expect(result.status).toBe('unsupported');
    expect(result.operations).toEqual([]);
    expect(result.reasons).toEqual(['16-bit source; v0 encodes 8-bit only']);
    expect(result.unresolved).toEqual(['maxWidth']);
  });

  it('refuses a format conversion for the same reason', () => {
    expect(plan(deep, { format: 'webp' }, ALLOW_RENAMES).status).toBe('unsupported');
  });

  it('names the depth it actually found', () => {
    const result = plan(image({ width: 4000, bitDepth: 32 }), { maxWidth: 800 });
    expect(result.reasons).toEqual(['32-bit source; v0 encodes 8-bit only']);
  });

  it('still corrects an extension, because a rename touches no pixels', () => {
    const mislabelled = image({ path: 'assets/deep.jpg', format: 'png', bitDepth: 16 });
    const result = plan(mislabelled, { format: 'png' }, ALLOW_RENAMES);

    expect(result.status).toBe('planned');
    expect(ops(result)).toEqual(['rename']);
    expect(result.targetPath).toBe('assets/deep.png');
  });

  it('leaves an ordinary 8-bit image alone', () => {
    expect(plan(image({ width: 4000, bitDepth: 8 }), { maxWidth: 800 }).status).toBe('planned');
  });
});

describe('multiple findings collapse into one plan', () => {
  const everything = image({
    path: 'assets/hero.jpg',
    width: 4000,
    height: 2500,
    bytes: 4_000_000,
    pixelColorSpace: 'cmyk',
    colorSpaceStatus: 'non-srgb',
    orientation: 6,
    storedWidth: 2500,
    storedHeight: 4000,
    hasExif: true,
  });
  const body: RuleBody = {
    maxWidth: 2400,
    maxBytes: 400_000,
    format: 'webp',
    colorSpace: 'srgb',
    stripMetadata: true,
    autoOrient: true,
  };

  it('produces the documented order, once each', () => {
    const result = plan(everything, body, ALLOW_RENAMES);
    expect(ops(result)).toEqual(['autoOrient', 'resize', 'toColorSpace', 'encode', 'rename']);
  });

  it('encodes exactly once, in the target format, with no contradictions', () => {
    const result = plan(everything, body, ALLOW_RENAMES);
    const encodes = result.operations.filter((operation) => operation.op === 'encode');

    expect(encodes).toHaveLength(1);
    expect(encodes[0]).toMatchObject({ format: 'webp', maxBytes: 400_000, stripMetadata: true });
    expect(result.operations.filter((operation) => operation.op === 'resize')).toHaveLength(1);
    expect(result.operations.filter((operation) => operation.op === 'rename')).toHaveLength(1);
  });

  it('resolves every error and normalizes the warning on the way through', () => {
    const result = plan(everything, body, ALLOW_RENAMES);

    expect(result.status).toBe('planned');
    expect([...result.resolves].sort()).toEqual(['colorSpace', 'format', 'maxBytes', 'maxWidth', 'orientation']);
    expect(result.unresolved).toEqual([]);
    expect(result.normalizedDuringRewrite).toEqual(['metadata']);
    expect(result.targetPath).toBe('assets/hero.webp');
  });
});

/**
 * The pipeline hands its buffer to `sharp().jpeg()` without asking questions,
 * and JPEG cannot hold an alpha channel: transparency flattens to black,
 * silently and irreversibly. Nothing in the encoder can catch that, so the
 * guarantee has to be that no plan ever asks for it in the first place.
 */
describe('a jpeg encode is never planned for a transparent source', () => {
  const alphaStates = [
    { label: 'used alpha', hasAlpha: true, isOpaque: false },
    { label: 'undetermined alpha', hasAlpha: true, isOpaque: null },
  ] as const;

  const bodies: RuleBody[] = [
    { format: 'jpeg' },
    { format: 'jpeg', maxWidth: 100 },
    { format: 'jpeg', maxBytes: 1000 },
    { format: 'jpeg', maxWidth: 100, maxBytes: 1000, stripMetadata: true, colorSpace: 'srgb' },
  ];

  for (const alpha of alphaStates) {
    for (const [index, body] of bodies.entries()) {
      for (const permissions of [NO_PERMISSIONS, ALLOW_RENAMES]) {
        it(`emits no jpeg encode preserving ${alpha.label} (policy ${index}, renames ${permissions.allowRenames})`, () => {
          const source = image({
            path: 'assets/logo.png',
            format: 'png',
            width: 400,
            height: 300,
            bytes: 50_000,
            hasAlpha: alpha.hasAlpha,
            isOpaque: alpha.isOpaque,
          });
          const result = plan(source, body, permissions);

          const encodes = [...result.operations, ...result.blockedOperations].filter(
            (operation) => operation.op === 'encode',
          );
          for (const encode of encodes) {
            expect(encode.format === 'jpeg' && encode.preserveAlpha).toBe(false);
          }
          // Belt and braces: this is the shape the policy actually produces.
          expect(result.status).toBe('unfixable');
        });
      }
    }
  }

  it('still allows a jpeg encode where the alpha channel is unused', () => {
    const opaque = image({ path: 'assets/logo.png', format: 'png', hasAlpha: true, isOpaque: true, width: 4000 });
    const result = plan(opaque, { format: 'jpeg', maxWidth: 300 }, ALLOW_RENAMES);
    expect(encodeIn(result)).toMatchObject({ format: 'jpeg', preserveAlpha: false });
  });
});

describe('determinism', () => {
  it('produces a deeply equal plan for the same inputs', () => {
    const info = image({ width: 4000, bytes: 4_000_000, hasExif: true });
    const body: RuleBody = { maxWidth: 2400, maxBytes: 400_000, format: 'webp', stripMetadata: true };

    expect(plan(info, body, ALLOW_RENAMES)).toEqual(plan(info, body, ALLOW_RENAMES));
    expect(plan(info, body)).toEqual(plan(info, body));
  });

  it('changes only with permissions, not with call order', () => {
    const info = image({ width: 4000 });
    const body: RuleBody = { maxWidth: 2400, format: 'webp' };

    const blockedFirst = [plan(info, body), plan(info, body, ALLOW_RENAMES)];
    const allowedFirst = [plan(info, body, ALLOW_RENAMES), plan(info, body)];

    expect(blockedFirst[0]).toEqual(allowedFirst[1]);
    expect(blockedFirst[1]).toEqual(allowedFirst[0]);
  });

  it('does not mutate the file result it was given', () => {
    const file = evaluate(image({ width: 4000 }), rule({ maxWidth: 2400 }));
    const before = structuredClone(file);
    planFile(file, ALLOW_RENAMES);
    expect(file).toEqual(before);
  });
});

describe('planning against a real resolved policy', () => {
  /** Resolution and evaluation exactly as the CLI does them, minus the filesystem. */
  function planWithPolicy(policy: Policy, info: ImageInfo, permissions = NO_PERMISSIONS): FilePlan {
    return planFile(evaluate(info, createResolver(policy).resolve(info.path)), permissions);
  }

  const policy: Policy = {
    version: 1,
    defaults: { stripMetadata: true, autoOrient: true, colorSpace: 'srgb' },
    rules: [
      { glob: 'assets/**/*.{jpg,jpeg,png,webp}', body: { maxWidth: 2400, maxBytes: 512_000 } },
      { glob: 'assets/heroes/**', body: { format: 'webp' } },
    ],
  };

  it('plans from a merged effective rule, not from a single glob', () => {
    const hero = image({ path: 'assets/heroes/hero.jpg', width: 4000, bytes: 900_000 });
    const result = planWithPolicy(policy, hero, ALLOW_RENAMES);

    expect(ops(result)).toEqual(['resize', 'encode', 'rename']);
    // maxWidth and maxBytes come from the broad rule, format from the narrow one.
    expect(encodeIn(result)).toMatchObject({ format: 'webp', maxBytes: 512_000, budgetDriven: true });
    expect(result.targetPath).toBe('assets/heroes/hero.webp');
  });

  it('plans nothing for a file the broad rule already satisfies', () => {
    const fine = image({ path: 'assets/photo.jpg', width: 1200, bytes: 100_000 });
    expect(planWithPolicy(policy, fine).status).toBe('unchanged');
  });
});
