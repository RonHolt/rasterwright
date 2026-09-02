/**
 * Generate the fixture image corpus.
 *
 * The images are real files produced by Sharp rather than binaries committed to
 * git. They are deterministic (fixed seed, fixed encoder settings) and tiny, and
 * `npm test` regenerates them automatically if they are missing.
 *
 * Fixture *projects* keep their `.rasterwright.yml` and a `.fixture.json`
 * manifest in git - those are the parts worth reading in a diff. This script
 * materializes each project's image files from the shared corpus.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES_DIR = path.join(REPO_ROOT, 'fixtures', 'images');
const PROJECTS_DIR = path.join(REPO_ROOT, 'fixtures', 'projects');

/** A small, deterministic PRNG so "noisy" fixtures are byte-stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random RGB noise, which no encoder can compress away. Used for size fixtures. */
function noise(width: number, height: number, seed: number): Buffer {
  const random = mulberry32(seed);
  const data = Buffer.allocUnsafe(width * height * 3);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.floor(random() * 256);
  return data;
}

/**
 * The same noise with an alpha channel that is genuinely used.
 *
 * Every 97th pixel is fully transparent, which is enough for sharp's `stats()`
 * to report `isOpaque: false` while leaving the image visually noise. A budget
 * fixture has to carry real alpha or the assertion that a quality search
 * preserves transparency is testing nothing.
 */
function noiseAlpha(width: number, height: number, seed: number): Buffer {
  const random = mulberry32(seed);
  const pixels = width * height;
  const data = Buffer.allocUnsafe(pixels * 4);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const at = pixel * 4;
    data[at] = Math.floor(random() * 256);
    data[at + 1] = Math.floor(random() * 256);
    data[at + 2] = Math.floor(random() * 256);
    data[at + 3] = pixel % 97 === 0 ? 0 : 255;
  }
  return data;
}

/**
 * A screenshot-shaped RGBA image: smooth gradients, hard horizontal and
 * vertical edges, a little sensor-style noise, and alpha that is genuinely used.
 *
 * This is the shape that exposed the PNG filtering problem in the wild. Flat
 * noise cannot show it, because no row filter helps there; gradients can, and a
 * single filter chosen for the whole image handles them badly enough to make a
 * lossless re-encode come out *larger* than the source (04 section 19).
 */
function screenshotAlpha(width: number, height: number, seed: number): Buffer {
  const random = mulberry32(seed);
  const data = Buffer.allocUnsafe(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const chrome = y % 40 < 3 || x % 53 < 2;
      const jitter = Math.floor(random() * 6);
      data[at] = chrome ? 30 : (Math.floor((x / width) * 180 + (y / height) * 50) + jitter) & 255;
      data[at + 1] = chrome ? 30 : (Math.floor((y / height) * 200) + jitter) & 255;
      data[at + 2] = chrome ? 30 : (Math.floor(120 + (x / width) * 80) + jitter) & 255;
      data[at + 3] = (x + y) % 211 === 0 ? 0 : 255;
    }
  }
  return data;
}

function solid(width: number, height: number, background: string) {
  return sharp({ create: { width, height, channels: 3, background } });
}

function solidAlpha(width: number, height: number, alpha: number) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 200, g: 60, b: 40, alpha } },
  });
}

interface Fixture {
  name: string;
  build: () => Promise<Buffer>;
}

const FIXTURES: Fixture[] = [
  // Small, clean, and inside every budget the fixture projects use.
  {
    name: 'compliant.jpg',
    build: () => solid(600, 400, '#4477aa').jpeg({ quality: 70, mozjpeg: true }).toBuffer(),
  },
  // Wide enough to break maxWidth: 800 and maxWidth: 1200.
  {
    name: 'oversized.jpg',
    build: () => solid(2000, 1200, '#aa7744').jpeg({ quality: 60, mozjpeg: true }).toBuffer(),
  },
  // Incompressible noise, so it blows a byte budget while staying small in pixels.
  {
    name: 'overbudget.jpg',
    build: () =>
      sharp(noise(700, 700, 1), { raw: { width: 700, height: 700, channels: 3 } })
        .jpeg({ quality: 95, mozjpeg: true })
        .toBuffer(),
  },
  // Incompressible noise in a lossless format. A maximum-effort re-encode of
  // this comes out the same size, so any ceiling below it is genuinely
  // unreachable and the PNG failure path is provoked honestly rather than by
  // an implausibly small budget.
  {
    name: 'noisy.png',
    build: () =>
      sharp(noise(400, 400, 7), { raw: { width: 400, height: 400, channels: 3 } })
        .png({ compressionLevel: 9 })
        .toBuffer(),
  },
  // Over its budget, with alpha that is actually used, so the quality search
  // has to preserve transparency on the way down.
  {
    name: 'noisy-alpha.webp',
    build: () =>
      sharp(noiseAlpha(500, 500, 11), { raw: { width: 500, height: 500, channels: 4 } })
        .webp({ quality: 95, effort: 4 })
        .toBuffer(),
  },
  // Truecolour RGBA with gradients: the case where a PNG re-encode without
  // adaptive filtering is no smaller than the source, and with it is far
  // smaller. Encoded here the way a screenshot tool would, with libvips'
  // default (non-adaptive) filtering.
  {
    name: 'screenshot.png',
    build: () =>
      sharp(screenshotAlpha(480, 360, 23), { raw: { width: 480, height: 360, channels: 4 } })
        .png({ compressionLevel: 9 })
        .toBuffer(),
  },
  { name: 'plain.png', build: () => solid(400, 300, '#33aa66').png({ compressionLevel: 9 }).toBuffer() },
  // Alpha channel that is actually used.
  { name: 'transparent.png', build: () => solidAlpha(400, 300, 0.35).png({ compressionLevel: 9 }).toBuffer() },
  // Alpha channel present but every pixel fully opaque: hasAlpha true, isOpaque true.
  { name: 'opaque-alpha.png', build: () => solidAlpha(400, 300, 1).png({ compressionLevel: 9 }).toBuffer() },
  // Tall, for maxHeight.
  { name: 'tall.png', build: () => solid(200, 1400, '#775599').png({ compressionLevel: 9 }).toBuffer() },
  { name: 'sample.webp', build: () => solid(500, 400, '#2288bb').webp({ quality: 75 }).toBuffer() },
  // EXIF orientation 6: stored landscape, displayed portrait.
  {
    name: 'rotated.jpg',
    build: () =>
      solid(600, 400, '#bb5533').jpeg({ quality: 70, mozjpeg: true }).withMetadata({ orientation: 6 }).toBuffer(),
  },
  // Carries EXIF (and, as a side effect of withMetadata, an sRGB ICC profile).
  {
    name: 'with-exif.jpg',
    build: () =>
      solid(600, 400, '#557799')
        .jpeg({ quality: 70, mozjpeg: true })
        .withExif({ IFD0: { Software: 'rasterwright-fixtures' } })
        .toBuffer(),
  },
  // CMYK pixels: confidently not sRGB.
  {
    name: 'cmyk.jpg',
    build: () => solid(400, 300, '#336699').toColourspace('cmyk').jpeg({ quality: 70 }).toBuffer(),
  },
  // WebP contents behind a .png extension. Taken from a real theme, where a
  // logo had been converted in place without renaming the file.
  {
    name: 'webp-named-png.png',
    build: () => solidAlpha(300, 200, 0.5).webp({ quality: 75 }).toBuffer(),
  },
  // JPEG contents behind a .jpeg extension: an alias, not a mismatch.
  {
    name: 'aliased.jpeg',
    build: () => solid(300, 200, '#99aa33').jpeg({ quality: 70, mozjpeg: true }).toBuffer(),
  },
  // Carries XMP but no EXIF, so the warning breakdown has more than one bucket.
  {
    name: 'with-xmp.png',
    build: () =>
      solid(300, 200, '#aa3366')
        .png({ compressionLevel: 9 })
        .withXmp(
          '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF ' +
            'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
            '<rdf:Description rdf:about=""/></rdf:RDF></x:xmpmeta><?xpacket end="r"?>',
        )
        .toBuffer(),
  },
  // An explicit sRGB ICC profile and nothing else. Colour management, not
  // disposable metadata: this must NOT produce a metadata warning.
  {
    name: 'srgb-profile.png',
    build: () =>
      solid(300, 200, '#3366aa').png({ compressionLevel: 9 }).keepIccProfile().withIccProfile('srgb').toBuffer(),
  },
  // 16 bits per channel. Sharp's encoders write 8, so any rewrite of this file
  // would silently halve its precision; v0 reports it as unsupported instead.
  // Wide enough to break a maxWidth rule, so the refusal is actually reached.
  {
    name: 'deep16.png',
    build: () => solid(1600, 900, '#33aa66').toColourspace('rgb16').png({ compressionLevel: 9 }).toBuffer(),
  },
  // Not an image at all, despite the extension.
  { name: 'corrupt.jpg', build: async () => Buffer.from('This is not a JPEG. Not even slightly.\n') },
];

async function writeImages(): Promise<void> {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  for (const fixture of FIXTURES) {
    const target = path.join(IMAGES_DIR, fixture.name);
    fs.writeFileSync(target, await fixture.build());
  }
}

interface FixtureManifest {
  /** Destination path inside the project -> fixture image name. */
  images: Record<string, string>;
}

function materializeProjects(): void {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  for (const entry of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(PROJECTS_DIR, entry.name);
    const manifestPath = path.join(projectDir, '.fixture.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as FixtureManifest;

    // Remove anything the manifest no longer lists. Without this a project
    // keeps every image it was ever given, so counts depend on the machine's
    // history rather than on what is committed.
    pruneGeneratedImages(projectDir, new Set(Object.keys(manifest.images)));

    for (const [destination, source] of Object.entries(manifest.images)) {
      const target = path.join(projectDir, destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(IMAGES_DIR, source), target);
    }
  }
}

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp)$/i;

/** Delete generated image files under `projectDir` that the manifest does not claim. */
function pruneGeneratedImages(projectDir: string, wanted: ReadonlySet<string>): void {
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        if (fs.readdirSync(absolute).length === 0) fs.rmdirSync(absolute);
        continue;
      }
      if (!entry.isFile() || !IMAGE_EXTENSIONS.test(entry.name)) continue;
      const relative = path.relative(projectDir, absolute).split(path.sep).join('/');
      if (!wanted.has(relative)) fs.unlinkSync(absolute);
    }
  };
  walk(projectDir);
}

export async function generateFixtures(): Promise<void> {
  await writeImages();
  materializeProjects();
}

const invokedDirectly = process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  await generateFixtures();
  process.stdout.write(`fixtures written to ${IMAGES_DIR}\n`);
}
