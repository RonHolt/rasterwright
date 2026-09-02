import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { evaluate } from '../../src/policy/evaluate.js';
import { planFile } from '../../src/operations/plan.js';
import { renderCandidate } from '../../src/operations/pipeline.js';
import { inspectBuffer } from '../../src/scanner/inspect.js';
import { FIXTURE_IMAGES } from '../helpers/project.js';
import type {
  EffectiveRule,
  FilePlan,
  FixPermissions,
  ImageInfo,
  RuleBody,
} from '../../src/types.js';

/**
 * The pipeline is tested through the real planner against real fixture images,
 * and the result is verified by re-inspecting the bytes it produced. Building
 * plans by hand would test the pipeline against a plan the planner never emits,
 * which is the one thing that cannot happen in production.
 *
 * Where colour is the point, pixels are read back with `{ ignoreIcc: true }`.
 * Reading them *without* it re-applies the ICC import, which makes a correctly
 * tagged non-sRGB output look identical to an sRGB one. That is the trap that
 * makes this question look settled when it is not.
 */

const ALLOW_RENAMES: FixPermissions = { allowRenames: true };

function rule(body: RuleBody): EffectiveRule {
  const sources: EffectiveRule['sources'] = {};
  for (const key of Object.keys(body) as (keyof RuleBody)[]) sources[key] = 'assets/**';
  return { body, matchedGlobs: ['assets/**'], sources };
}

interface Rendered {
  plan: FilePlan;
  source: ImageInfo;
  candidate: Buffer;
  output: ImageInfo;
}

async function infoFor(label: string, bytes: Buffer): Promise<ImageInfo> {
  const result = await inspectBuffer(label, bytes);
  if (!result.ok) throw new Error(`could not inspect ${label}: ${result.error}`);
  return result.info;
}

/** Plan `bytes` under `body` exactly as a run would, then render the candidate. */
async function render(label: string, bytes: Buffer, body: RuleBody): Promise<Rendered> {
  const source = await infoFor(label, bytes);
  const plan = planFile(evaluate(source, rule(body)), ALLOW_RENAMES);
  if (plan.status !== 'planned') {
    throw new Error(`expected a plan for ${label}, got ${plan.status}: ${plan.reasons.join('; ')}`);
  }
  const candidate = await renderCandidate(bytes, plan, source);
  return { plan, source, candidate, output: await infoFor(plan.targetPath, candidate) };
}

function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_IMAGES, name));
}

/** Stored pixel values, with the ICC import deliberately skipped. */
async function pixels(bytes: Buffer): Promise<number[]> {
  const raw = await sharp(bytes, { ignoreIcc: true }).raw().toBuffer();
  return [...raw.subarray(0, 4)];
}

async function iccOf(bytes: Buffer): Promise<Buffer | undefined> {
  return (await sharp(bytes).metadata()).icc;
}

describe('autoOrient', () => {
  it('applies the flag to the pixels and clears it', async () => {
    const { source, output } = await render('rotated.jpg', fixture('rotated.jpg'), { autoOrient: true });

    expect(source).toMatchObject({ storedWidth: 600, storedHeight: 400, orientation: 6 });
    expect(output).toMatchObject({ storedWidth: 400, storedHeight: 600, orientation: 1 });
  });

  it('leaves the displayed image looking the same', async () => {
    const { source, output } = await render('rotated.jpg', fixture('rotated.jpg'), { autoOrient: true });
    expect([output.width, output.height]).toEqual([source.width, source.height]);
  });
});

describe('resize', () => {
  it('lands exactly on the planned dimensions', async () => {
    const { plan, output } = await render('oversized.jpg', fixture('oversized.jpg'), { maxWidth: 800 });

    const resize = plan.operations.find((operation) => operation.op === 'resize');
    expect(resize?.to).toEqual({ width: 800, height: 480 });
    expect([output.width, output.height]).toEqual([800, 480]);
  });

  it('never lands over the limit when the ratio does not divide evenly', async () => {
    for (const maxWidth of [777, 999, 1333, 137]) {
      const { output } = await render('oversized.jpg', fixture('oversized.jpg'), { maxWidth });
      expect(output.width).toBeLessThanOrEqual(maxWidth);
    }
  });

  it('honours a height limit', async () => {
    const { output } = await render('tall.png', fixture('tall.png'), { maxHeight: 600 });
    expect(output.width).toBe(85);
    expect(output.height).toBeLessThanOrEqual(600);
  });

  it('can land under the planned target, never over it', async () => {
    // The planner floors width and height independently from one ratio, so the
    // pair it names is not always exactly the source's aspect ratio. `fit:
    // 'inside'` keeps the aspect ratio exactly and honours the tighter of the
    // two, which can come out a few pixels short. Short is compliant and stays
    // compliant; over would make the next run resize the file again.
    const { plan, output } = await render('tall.png', fixture('tall.png'), { maxHeight: 600 });

    const resize = plan.operations.find((operation) => operation.op === 'resize');
    expect(resize?.to).toEqual({ width: 85, height: 600 });
    expect(output.width).toBeLessThanOrEqual(resize?.to.width ?? 0);
    expect(output.height).toBeLessThanOrEqual(resize?.to.height ?? 0);
    // The source's aspect ratio is preserved rather than the planner's rounding.
    expect(output.width / output.height).toBeCloseTo(200 / 1400, 3);
  });

  it('leaves a resized file compliant, so the next run has nothing to do', async () => {
    for (const [name, body] of [
      ['oversized.jpg', { maxWidth: 800 }],
      ['oversized.jpg', { maxWidth: 777, maxHeight: 333 }],
      ['tall.png', { maxHeight: 600 }],
    ] as [string, RuleBody][]) {
      const { output } = await render(name, fixture(name), body);
      expect(planFile(evaluate(output, rule(body)), ALLOW_RENAMES).status).toBe('unchanged');
    }
  });

  it('never enlarges an image that is already inside the limits', async () => {
    // The width violation forces the rewrite; the height limit is slack and
    // must not stretch anything to fill it.
    const { source, output } = await render('oversized.jpg', fixture('oversized.jpg'), {
      maxWidth: 800,
      maxHeight: 10_000,
    });
    expect(output.width).toBeLessThan(source.width);
    expect(output.height).toBeLessThan(source.height);
  });
});

describe('colour', () => {
  it('tags the output sRGB and converts the pixels when policy says so', async () => {
    const { source, output, candidate } = await render('cmyk.jpg', fixture('cmyk.jpg'), {
      colorSpace: 'srgb',
    });

    expect(source.colorSpaceStatus).toBe('non-srgb');
    expect(output.colorSpaceStatus).toBe('srgb');
    expect(output.hasIccProfile).toBe(true);
    expect(output.pixelColorSpace).toBe('srgb');

    // The source was built from #336699, so the converted pixels should be
    // recognisably that colour rather than four CMYK channels.
    const [red, green, blue] = await pixels(candidate);
    expect(red).toBeGreaterThan(30);
    expect(red).toBeLessThan(80);
    expect(green).toBeGreaterThan(80);
    expect(green).toBeLessThan(125);
    expect(blue).toBeGreaterThan(130);
    expect(blue).toBeLessThan(175);
  });

  it('keeps a non-sRGB profile, and its pixels, where no colour policy applies', async () => {
    // Discarding a profile changes how every pixel is interpreted. That is not
    // a normalization, so a rewrite forced by something else must not do it.
    const p3 = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#cc3311' } })
      .withIccProfile('p3')
      .png({ compressionLevel: 9 })
      .toBuffer();

    const { source, output, candidate } = await render('assets/wide.png', p3, { maxWidth: 200 });

    expect(source.colorSpaceStatus).toBe('non-srgb');
    expect(output.colorSpaceStatus).toBe('non-srgb');
    expect(output.iccDescription).toBe(source.iccDescription);
    expect(await iccOf(candidate)).toEqual(await iccOf(p3));
    expect(await pixels(candidate)).toEqual(await pixels(p3));
  });

  it('adds no profile to an untagged image it merely resized', async () => {
    const { source, output } = await render('oversized.jpg', fixture('oversized.jpg'), { maxWidth: 800 });
    expect(source.hasIccProfile).toBe(false);
    expect(output.hasIccProfile).toBe(false);
  });
});

describe('metadata', () => {
  it('strips ancillary metadata during a rewrite an error required', async () => {
    const { source, output } = await render('with-exif.jpg', fixture('with-exif.jpg'), {
      maxWidth: 300,
      stripMetadata: true,
    });

    expect(source.hasExif).toBe(true);
    expect(output.hasExif).toBe(false);
  });

  it('keeps it when the policy asks for it to be kept', async () => {
    const { output } = await render('with-exif.jpg', fixture('with-exif.jpg'), {
      maxWidth: 300,
      stripMetadata: false,
    });
    expect(output.hasExif).toBe(true);
  });
});

describe('orientation preserved through a rewrite it did not ask for', () => {
  const body: RuleBody = { autoOrient: false, maxWidth: 300, stripMetadata: true };

  it('is what a plain re-encode would get wrong', async () => {
    // The bug this exists to prevent: sharp drops metadata by default, so the
    // flag disappears while the pixels stay unrotated, and the image that
    // displayed as 400x600 starts displaying as 600x400.
    const naive = await sharp(fixture('rotated.jpg')).jpeg({ quality: 82 }).toBuffer();
    const wrong = await infoFor('naive.jpg', naive);

    expect(wrong.orientation).toBe(1);
    expect([wrong.width, wrong.height]).toEqual([600, 400]);
  });

  it('carries the flag into the output', async () => {
    const { plan, output } = await render('rotated.jpg', fixture('rotated.jpg'), body);

    const encode = plan.operations.find((operation) => operation.op === 'encode');
    expect(encode?.preservesOrientation).toBe(true);
    expect(output.orientation).toBe(6);
  });

  it('resizes the stored pixels along the right axis', async () => {
    // The plan is stated in displayed dimensions, and the stored image has its
    // axes swapped. Resizing to the displayed target directly would fit the
    // long stored edge into the short limit and shrink the image far more than
    // the policy asked for.
    const { plan, output } = await render('rotated.jpg', fixture('rotated.jpg'), body);

    const resize = plan.operations.find((operation) => operation.op === 'resize');
    expect(resize?.to).toEqual({ width: 300, height: 450 });
    expect([output.storedWidth, output.storedHeight]).toEqual([450, 300]);
    expect([output.width, output.height]).toEqual([300, 450]);
  });

  it('carries whatever flag the source had, for every rotation', async () => {
    // Sharp fills the orientation in from the source and ignores the value
    // passed to `withExif`, so this asserts the property that actually holds:
    // the output flag equals the input flag, whatever it was.
    for (const orientation of [3, 6, 8]) {
      const source = await sharp({
        create: { width: 600, height: 400, channels: 3, background: '#bb5533' },
      })
        .jpeg({ quality: 70 })
        .withMetadata({ orientation })
        .toBuffer();

      const { output } = await render('assets/turned.jpg', source, body);
      expect(output.orientation).toBe(orientation);
    }
  });

  it('writes a minimal EXIF block and no ICC profile of its own', async () => {
    const { candidate } = await render('rotated.jpg', fixture('rotated.jpg'), body);
    const exif = (await sharp(candidate).metadata()).exif;

    expect(exif).toBeDefined();
    // A whole EXIF block copied across would be far larger than this.
    expect((exif?.byteLength ?? 0)).toBeLessThan(256);
  });

  it('produces a metadata warning on the next check, and only a warning', async () => {
    // Expected, and deliberately not a reason to rewrite the file again: this
    // is what keeps the second run writing zero bytes.
    const { candidate, plan } = await render('rotated.jpg', fixture('rotated.jpg'), body);
    const output = await infoFor(plan.targetPath, candidate);
    const recheck = evaluate(output, rule(body));

    expect(recheck.findings.map((finding) => finding.check)).toContain('metadata');
    expect(recheck.findings.every((finding) => finding.severity !== 'error')).toBe(true);
    expect(planFile(recheck, ALLOW_RENAMES).status).toBe('unchanged');
  });
});

describe('transparency', () => {
  it('survives a PNG to WebP conversion', async () => {
    const { source, plan, output } = await render('transparent.png', fixture('transparent.png'), {
      format: 'webp',
    });

    expect(source).toMatchObject({ hasAlpha: true, isOpaque: false });
    expect(plan.targetPath).toBe('transparent.webp');
    expect(output).toMatchObject({ format: 'webp', hasAlpha: true, isOpaque: false });
  });

  it('survives re-encoding WebP bytes hiding behind a .png name', async () => {
    // The policy resolves this mismatch by making the file really be a PNG,
    // rather than by renaming it, so the alpha has to come through the encoder.
    const { source, plan, output } = await render(
      'webp-named-png.png',
      fixture('webp-named-png.png'),
      { format: 'png' },
    );

    expect(source.format).toBe('webp');
    expect(plan.targetPath).toBe('webp-named-png.png');
    expect(output).toMatchObject({ format: 'png', hasAlpha: true, isOpaque: false });
  });
});

describe('determinism', () => {
  it('produces byte-identical output for the same input and plan', async () => {
    const cases: [string, RuleBody][] = [
      ['oversized.jpg', { maxWidth: 800 }],
      ['transparent.png', { format: 'webp' }],
      ['rotated.jpg', { autoOrient: true }],
      ['cmyk.jpg', { colorSpace: 'srgb' }],
    ];

    for (const [name, body] of cases) {
      const first = await render(name, fixture(name), body);
      const second = await render(name, fixture(name), body);
      expect(second.candidate.equals(first.candidate)).toBe(true);
    }
  });
});

describe('what the pipeline refuses to do', () => {
  it('refuses a plan whose encode is driven by a byte budget', async () => {
    // The quality search does not exist yet. Failing after a wasted encode
    // would read as a bug rather than as a stated limitation.
    const bytes = fixture('overbudget.jpg');
    const source = await infoFor('heavy.jpg', bytes);
    const plan = planFile(evaluate(source, rule({ maxBytes: 20_000 })), ALLOW_RENAMES);

    const encode = plan.operations.find((operation) => operation.op === 'encode');
    expect(encode?.budgetDriven).toBe(true);
    await expect(renderCandidate(bytes, plan, source)).rejects.toThrow(/byte budget/);
  });

  it('refuses a 16-bit source, whose precision an encode would halve', async () => {
    // The planner already reports these as unsupported. This is the check on
    // the other side of that boundary: it is the planner that would have to
    // change for a 16-bit buffer to reach the encoder.
    const bytes = fixture('deep16.png');
    const source = await infoFor('deep.png', bytes);
    expect(source.bitDepth).toBe(16);

    const plan = planFile(evaluate(source, rule({ maxWidth: 800 })), ALLOW_RENAMES);
    const forced: FilePlan = {
      ...plan,
      status: 'planned',
      operations: [
        { op: 'resize', from: { width: 1600, height: 900 }, to: { width: 800, height: 450 }, fit: 'inside', upscale: false },
        {
          op: 'encode',
          format: 'png',
          budgetDriven: false,
          stripMetadata: true,
          preserveAlpha: false,
          lossyReencode: false,
          outcomeRequiresVerification: false,
          preservesOrientation: false,
        },
      ],
    };

    await expect(renderCandidate(bytes, forced, source)).rejects.toThrow(/16-bit/);
  });

  it('refuses to flatten transparency into a JPEG', async () => {
    const bytes = fixture('transparent.png');
    const source = await infoFor('logo.png', bytes);

    const forced: FilePlan = {
      ...planFile(evaluate(source, rule({ maxWidth: 200 })), ALLOW_RENAMES),
      status: 'planned',
      targetPath: 'logo.jpg',
      operations: [
        {
          op: 'encode',
          format: 'jpeg',
          budgetDriven: false,
          quality: { start: 82, floor: 40 },
          stripMetadata: true,
          preserveAlpha: true,
          lossyReencode: false,
          outcomeRequiresVerification: false,
          preservesOrientation: false,
        },
      ],
    };

    await expect(renderCandidate(bytes, forced, source)).rejects.toThrow(/transparency/);

    // And still refuses when the flag disagrees with the image itself, because
    // the image is what actually gets flattened.
    const lying: FilePlan = {
      ...forced,
      operations: forced.operations.map((operation) =>
        operation.op === 'encode' ? { ...operation, preserveAlpha: false } : operation,
      ),
    };
    await expect(renderCandidate(bytes, lying, source)).rejects.toThrow(/transparency/);
  });

  it('still encodes a JPEG from a source whose alpha channel is unused', async () => {
    const { output } = await render('opaque-alpha.png', fixture('opaque-alpha.png'), {
      format: 'jpeg',
      maxWidth: 200,
    });
    expect(output.format).toBe('jpeg');
  });

  it('refuses a plan with nothing to encode', async () => {
    const bytes = fixture('compliant.jpg');
    const source = await infoFor('compliant.jpg', bytes);
    const plan = planFile(evaluate(source, rule({ maxWidth: 2400 })), ALLOW_RENAMES);

    expect(plan.status).toBe('unchanged');
    await expect(renderCandidate(bytes, plan, source)).rejects.toThrow(/no encode operation/);
  });
});
