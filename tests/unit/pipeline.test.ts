import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { evaluate } from '../../src/policy/evaluate.js';
import { planFile } from '../../src/operations/plan.js';
import {
  renderCandidate,
  searchQuality,
  type RenderedCandidate,
} from '../../src/operations/pipeline.js';
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
  encoded: RenderedCandidate;
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
  const encoded = await renderCandidate(bytes, plan, source);
  return {
    plan,
    source,
    candidate: encoded.buffer,
    encoded,
    output: await infoFor(plan.targetPath, encoded.buffer),
  };
}

function fixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_IMAGES, name));
}

/** Stored pixel values, with the ICC import deliberately skipped. */
async function pixels(bytes: Buffer): Promise<number[]> {
  const raw = await sharp(bytes, { ignoreIcc: true }).raw().toBuffer();
  return [...raw.subarray(0, 4)];
}

/** Every stored pixel, same caveat: what a lossless claim has to be checked against. */
async function rawPixels(bytes: Buffer): Promise<Buffer> {
  return sharp(bytes, { ignoreIcc: true }).raw().toBuffer();
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
    expect(output.width).toBe(86);
    expect(output.height).toBeLessThanOrEqual(600);
  });

  it('lands exactly on the dimensions the plan named', async () => {
    // The dry run publishes `resize.to`, so it has to be what the file gets.
    // 200x1400 under `maxHeight: 600` scales to 85.71 wide, and libvips rounds
    // that to 86; a planner that floored it to 85 would both name a size the
    // file never has and, by handing that flatter box to `fit: 'inside'`, make
    // libvips shrink the image a second time to fit it.
    const { plan, output } = await render('tall.png', fixture('tall.png'), { maxHeight: 600 });

    const resize = plan.operations.find((operation) => operation.op === 'resize');
    expect(resize?.to).toEqual({ width: 86, height: 600 });
    expect([output.width, output.height]).toEqual([86, 600]);
    // The source's aspect ratio is preserved, and neither limit is exceeded.
    expect(output.width / output.height).toBeCloseTo(200 / 1400, 3);
  });

  it('names the dimensions the file gets, over a spread of limits and shapes', async () => {
    // The dry run's claim is that it states what will happen, so `resize.to`
    // and the bytes on disk have to agree for every shape, not just the ones
    // whose ratio divides evenly. This is the regression guard for the planner
    // naming 1600x625 and writing 1598x625.
    const shapes: [string, RuleBody][] = [
      ['oversized.jpg', { maxWidth: 777 }],
      ['oversized.jpg', { maxWidth: 999 }],
      ['oversized.jpg', { maxWidth: 1333 }],
      ['oversized.jpg', { maxWidth: 137 }],
      ['oversized.jpg', { maxHeight: 301 }],
      ['oversized.jpg', { maxWidth: 640, maxHeight: 480 }],
      ['tall.png', { maxHeight: 600 }],
      ['tall.png', { maxHeight: 333 }],
      ['tall.png', { maxWidth: 111 }],
      ['tall.png', { maxWidth: 90, maxHeight: 700 }],
    ];

    for (const [name, body] of shapes) {
      const { plan, output } = await render(name, fixture(name), body);
      const resize = plan.operations.find((operation) => operation.op === 'resize');
      expect(resize, `${name} under ${JSON.stringify(body)} planned no resize`).toBeDefined();
      expect([output.width, output.height], `${name} under ${JSON.stringify(body)}`).toEqual([
        resize?.to.width,
        resize?.to.height,
      ]);
      if (body.maxWidth !== undefined) expect(output.width).toBeLessThanOrEqual(body.maxWidth);
      if (body.maxHeight !== undefined) expect(output.height).toBeLessThanOrEqual(body.maxHeight);
    }
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

/**
 * The search, against a stubbed encoder.
 *
 * Nothing here decodes an image. The assertions are about the algorithm - which
 * qualities it probes, which one it keeps, and what it reports when none fit -
 * and a synthetic size function is the only way to state them exactly,
 * including for a curve no real encoder is guaranteed not to produce.
 */
describe('searchQuality', () => {
  /** An encoder whose output size is `sizeAt(quality)` bytes. Records every probe. */
  function encoder(sizeAt: (quality: number) => number) {
    const probes: number[] = [];
    const encode = async (quality: number): Promise<Buffer> => {
      probes.push(quality);
      return Buffer.alloc(sizeAt(quality));
    };
    return { probes, encode };
  }

  /** Monotone and strictly decreasing: 100 bytes per quality point. */
  const linear = (quality: number): number => quality * 100;

  it('encodes once at the start quality when there is no ceiling at all', async () => {
    const { probes, encode } = encoder(linear);
    const result = await searchQuality({ start: 82, floor: 40 }, undefined, encode);

    expect(probes).toEqual([82]);
    expect(result.quality).toEqual({
      start: 82,
      chosen: 82,
      floor: 40,
      searched: false,
      attempts: 1,
    });
  });

  it('encodes once when the start quality already fits', async () => {
    const { probes, encode } = encoder(linear);
    const result = await searchQuality({ start: 82, floor: 40 }, 8_200, encode);

    expect(probes).toEqual([82]);
    expect(result.quality.searched).toBe(false);
    expect(result.buffer.length).toBe(8_200);
  });

  it('keeps the highest quality that fits', async () => {
    const { probes, encode } = encoder(linear);
    // 6,150 bytes admits quality 61 and nothing above it.
    const result = await searchQuality({ start: 82, floor: 40 }, 6_150, encode);

    expect(result.quality.chosen).toBe(61);
    expect(result.quality.searched).toBe(true);
    expect(result.buffer.length).toBe(6_100);
    expect(probes.every((quality) => quality >= 40 && quality <= 82)).toBe(true);
    expect(probes.slice(1).every((quality) => quality <= 81)).toBe(true);
  });

  it('accepts a candidate exactly on the ceiling and refuses one byte over it', async () => {
    // The difference between `<=` and `<`, which is the whole meaning of a
    // ceiling and is not something to leave to a reading of the code.
    const exact = await searchQuality({ start: 82, floor: 40 }, 6_100, encoder(linear).encode);
    expect(exact.quality.chosen).toBe(61);

    const over = await searchQuality({ start: 82, floor: 40 }, 6_099, encoder(linear).encode);
    expect(over.quality.chosen).toBe(60);
  });

  it('never probes below the floor, and reports the floor when nothing fits', async () => {
    const { probes, encode } = encoder(linear);
    const result = await searchQuality({ start: 82, floor: 40 }, 1_000, encode);

    expect(Math.min(...probes)).toBe(40);
    expect(result.quality.chosen).toBe(40);
    expect(result.buffer.length).toBe(4_000);
    expect(result.quality.searched).toBe(true);
  });

  it('probes once when the floor equals the start, and reports that probe', async () => {
    // A legal config: `parseQuality` refuses only `floor > start`. The range
    // [floor, start - 1] is then empty, so the loop body never runs and an
    // implementation assuming at least one iteration would report nothing.
    const { probes, encode } = encoder(linear);
    const result = await searchQuality({ start: 60, floor: 60 }, 1_000, encode);

    expect(probes).toEqual([60]);
    expect(result.quality).toEqual({
      start: 60,
      chosen: 60,
      floor: 60,
      searched: false,
      attempts: 1,
    });
  });

  it('reports the smallest measured probe when a tiny ceiling admits nothing', async () => {
    const { encode } = encoder(linear);
    const result = await searchQuality({ start: 82, floor: 40 }, 1, encode);

    expect(result.buffer.length).toBe(4_000);
    expect(result.quality.chosen).toBe(40);
  });

  it('accepts only probes it measured under the ceiling, monotone or not', async () => {
    // Quality 60 is the search's *first* probe under this band and ceiling, and
    // it is deliberately larger than its neighbours. An implementation that
    // trusted the binary-search invariant would take it and write bytes over
    // the ceiling; the property is that whatever comes back genuinely fits.
    const bumpy = (quality: number): number => (quality === 60 ? 99_999 : quality * 100);
    const { probes, encode } = encoder(bumpy);
    const result = await searchQuality({ start: 82, floor: 40 }, 6_150, encode);

    expect(probes).toContain(60);
    expect(result.quality.chosen).not.toBe(60);
    expect(result.buffer.length).toBeLessThanOrEqual(6_150);
    expect(bumpy(result.quality.chosen)).toBe(result.buffer.length);
  });

  it('can miss a fitting quality on a non-monotone curve, and never writes over the ceiling', async () => {
    // The honest cost of a binary search over a curve that is not monotone. The
    // inversion at 60 makes the search abandon the whole upper half, so it
    // returns 59 where 61 also fits. A missed optimization, never a wrong
    // write, and worth pinning so nobody "fixes" it into an unsound search.
    const bumpy = (quality: number): number => (quality === 60 ? 99_999 : quality * 100);
    const result = await searchQuality({ start: 82, floor: 40 }, 6_150, encoder(bumpy).encode);

    expect(result.quality.chosen).toBe(59);
    expect(bumpy(61)).toBeLessThanOrEqual(6_150);
  });

  it('can report a failure where an isolated fitting quality existed', async () => {
    // The worst case of the same trade, stated out loud: only quality 70 fits,
    // the search probes 60 first, finds it over, and abandons the half that
    // contains 70. The failure is honest about what it measured and the
    // original is left alone, which is the property that matters. Fixing this
    // would mean a linear scan of the whole band on every over-budget file.
    const size = (quality: number): number => (quality === 70 ? 5_000 : 9_000);
    const result = await searchQuality({ start: 82, floor: 40 }, 6_000, encoder(size).encode);

    expect(result.buffer.length).toBeGreaterThan(6_000);
    expect(size(70)).toBeLessThanOrEqual(6_000);
  });

  it('never needs more than eight encodes, over the whole legal quality range', async () => {
    // 1..100 is the widest band the schema allows, and a binary search over 99
    // values needs seven probes plus the initial one. Asserted as an invariant
    // rather than enforced as a cap: a cap that stopped early would make the
    // chosen quality depend on the width of the band, and the run would stop
    // being deterministic in the way this phase promises.
    for (const ceiling of [1, 5_000, 9_999, 10_000]) {
      const { encode } = encoder(linear);
      const result = await searchQuality({ start: 100, floor: 1 }, ceiling, encode);
      expect(result.quality.attempts, `ceiling ${ceiling}`).toBeLessThanOrEqual(8);
    }
  });
});

describe('the byte-budget search over real encodes', () => {
  it('lands on the highest quality that fits, and the next one up does not', async () => {
    const { encoded, output } = await render('overbudget.jpg', fixture('overbudget.jpg'), {
      maxBytes: 200 * 1024,
    });

    expect(encoded.quality?.searched).toBe(true);
    expect(encoded.bytes).toBeLessThanOrEqual(200 * 1024);
    expect(output.bytes).toBe(encoded.bytes);

    // The search found the true maximum, not merely something that fits: one
    // quality point higher is over the ceiling.
    const chosen = encoded.quality?.chosen ?? 0;
    const higher = await sharp(fixture('overbudget.jpg'))
      .jpeg({ quality: chosen + 1, mozjpeg: true, progressive: true })
      .toBuffer();
    expect(higher.length).toBeGreaterThan(200 * 1024);
  });

  it('stays inside the band and inside the attempt budget', async () => {
    const { encoded } = await render('overbudget.jpg', fixture('overbudget.jpg'), {
      maxBytes: 200 * 1024,
    });

    const quality = encoded.quality;
    expect(quality?.floor).toBe(40);
    expect(quality?.chosen).toBeGreaterThanOrEqual(40);
    expect(quality?.chosen).toBeLessThan(82);
    expect(quality?.attempts).toBeLessThanOrEqual(8);
  });

  it('encodes exactly once when the plan has no byte ceiling', async () => {
    const { encoded } = await render('oversized.jpg', fixture('oversized.jpg'), { maxWidth: 800 });

    expect(encoded.quality).toEqual({
      start: 82,
      chosen: 82,
      floor: 40,
      searched: false,
      attempts: 1,
    });
  });

  it('applies the resize once, so every probe encodes the resized image', async () => {
    const { encoded, output } = await render('overbudget.jpg', fixture('overbudget.jpg'), {
      maxWidth: 300,
      maxBytes: 100 * 1024,
    });

    expect([output.width, output.height]).toEqual([300, 300]);
    expect(encoded.bytes).toBeLessThanOrEqual(100 * 1024);
    // The downscale alone brings it well under, so the start quality is kept.
    expect(encoded.quality?.searched).toBe(false);
  });

  it('keeps meaningful transparency through a WebP search', async () => {
    const { source, encoded, output } = await render(
      'noisy-alpha.webp',
      fixture('noisy-alpha.webp'),
      { maxBytes: 150 * 1024 },
    );

    expect(source).toMatchObject({ hasAlpha: true, isOpaque: false });
    expect(encoded.quality?.searched).toBe(true);
    expect(encoded.bytes).toBeLessThanOrEqual(150 * 1024);
    expect(output).toMatchObject({ format: 'webp', hasAlpha: true, isOpaque: false });
  });

  it('re-encodes a PNG losslessly, once, and reports no quality at all', async () => {
    const { encoded } = await render('noisy.png', fixture('noisy.png'), { maxBytes: 200 * 1024 });

    expect(encoded.format).toBe('png');
    expect(encoded.quality).toBeUndefined();
    // Incompressible: the maximum-effort re-encode buys nothing, which is
    // exactly why the executor has to fail this file rather than write it.
    expect(encoded.bytes).toBeGreaterThan(200 * 1024);
  });

  it('filters PNG rows adaptively, which shrinks the file without touching a pixel', async () => {
    // The regression this guards: without `adaptiveFiltering`, a maximum-effort
    // re-encode of a truecolour RGBA screenshot came out no smaller than the
    // source, and on real files larger than it. One filter for the whole image
    // handles gradients badly. See 04 section 19.
    const bytes = fixture('screenshot.png');
    const { encoded, output, candidate } = await render('screenshot.png', bytes, {
      maxBytes: 300 * 1024,
    });

    const nonAdaptive = await sharp(bytes)
      .png({ compressionLevel: 9, effort: 10, palette: false })
      .toBuffer();

    expect(encoded.format).toBe('png');
    expect(encoded.quality).toBeUndefined();
    expect(encoded.bytes).toBeLessThanOrEqual(nonAdaptive.length);
    // And it is a real saving, not a tie: the non-adaptive encode is the size
    // the source already was, so a rewrite would have bought nothing.
    expect(encoded.bytes).toBeLessThan(bytes.length);
    expect(encoded.bytes).toBeLessThanOrEqual(300 * 1024);

    // Lossless is the whole claim. Every stored pixel, compared with the ICC
    // import deliberately skipped so a colour change cannot hide behind it.
    expect(output).toMatchObject({ format: 'png', hasAlpha: true, isOpaque: false });
    expect((await rawPixels(candidate)).equals(await rawPixels(bytes))).toBe(true);
  });

  it('hands back the smallest probe when nothing fits, with the quality that made it', async () => {
    const { encoded, plan } = await render('overbudget.jpg', fixture('overbudget.jpg'), {
      maxBytes: 20 * 1024,
    });

    // The pipeline decides nothing: it returns the best it could do and lets
    // verification refuse it. Anything else would put the decision to write in
    // two places.
    expect(plan.status).toBe('planned');
    expect(encoded.quality?.chosen).toBe(40);
    expect(encoded.bytes).toBeGreaterThan(20 * 1024);
  });

  it('picks the same quality and the same bytes on a second run', async () => {
    for (const [name, body] of [
      ['overbudget.jpg', { maxBytes: 200 * 1024 }],
      ['noisy-alpha.webp', { maxBytes: 150 * 1024 }],
      ['noisy.png', { maxBytes: 200 * 1024 }],
    ] as [string, RuleBody][]) {
      const first = await render(name, fixture(name), body);
      const second = await render(name, fixture(name), body);

      expect(second.encoded.quality, name).toEqual(first.encoded.quality);
      expect(second.candidate.equals(first.candidate), name).toBe(true);
    }
  });
});

describe('what the pipeline refuses to do', () => {
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
