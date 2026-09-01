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
    for (const [destination, source] of Object.entries(manifest.images)) {
      const target = path.join(projectDir, destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(IMAGES_DIR, source), target);
    }
  }
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
