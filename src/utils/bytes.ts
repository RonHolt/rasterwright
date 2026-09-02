import { ConfigError } from './errors.js';

/**
 * Byte units in Rasterwright are BINARY.
 *
 *   1 kb = 1 KB = 1 KiB = 1024 bytes
 *   1 mb = 1 MB = 1 MiB = 1024 * 1024 bytes
 *
 * This is a coin flip either way (SI says 1000). Rasterwright picks 1024
 * because that is what a developer's file browser and `ls -lh` show them, and
 * because the number in the config exists to be compared against what they
 * already saw. It is documented here, in the README, and in generated configs
 * so nobody has to guess. Casing is irrelevant: `kb`, `Kb`, `KB` and `KiB` are
 * the same unit.
 */
const UNITS: Record<string, number> = {
  '': 1,
  b: 1,
  byte: 1,
  bytes: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
};

const PATTERN = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-z]*)\s*$/i;

/**
 * Parse a config byte value into whole bytes.
 *
 * Accepts a plain number (already bytes) or a string with an optional unit.
 * Fractional results are rounded to the nearest whole byte.
 *
 * @param where - a path like `rules["assets/**"].maxBytes`, used in error text.
 */
export function parseBytes(value: unknown, where: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`${where}: expected a positive byte count, got ${value}`);
    }
    if (!Number.isInteger(value)) {
      throw new ConfigError(
        `${where}: expected a whole number of bytes, got ${value}`,
        'Use a string with a unit instead, e.g. "0.5mb".',
      );
    }
    return value;
  }

  if (typeof value !== 'string') {
    throw new ConfigError(
      `${where}: expected a byte size such as 500kb, 1mb or 512000, got ${JSON.stringify(value)}`,
    );
  }

  const match = PATTERN.exec(value);
  if (!match) {
    throw new ConfigError(
      `${where}: could not parse ${JSON.stringify(value)} as a byte size`,
      'Supported forms: 512000, "500kb", "500 KB", "1mb", "0.5mb".',
    );
  }

  const [, digits = '', rawUnit = ''] = match;
  const multiplier = UNITS[rawUnit.toLowerCase()];
  if (multiplier === undefined) {
    throw new ConfigError(
      `${where}: unknown byte unit ${JSON.stringify(rawUnit)} in ${JSON.stringify(value)}`,
      `Known units: ${Object.keys(UNITS).filter(Boolean).join(', ')}. All are 1024-based.`,
    );
  }

  const bytes = Math.round(Number(digits) * multiplier);
  if (bytes <= 0) {
    throw new ConfigError(`${where}: byte size must be greater than zero, got ${JSON.stringify(value)}`);
  }
  return bytes;
}

/**
 * Human display of a byte count, using the same 1024 basis `parseBytes` accepts.
 *
 * `decimals` overrides the default precision. It exists for `formatBytesPair`
 * and is not something a caller printing one number should reach for.
 */
export function formatBytes(bytes: number, decimals?: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const places = decimals ?? (value < 10 ? 1 : 0);
  return `${value.toFixed(places)} ${units[unit]}`;
}

/**
 * Two byte counts that appear in one sentence, at a precision that keeps them
 * apart.
 *
 * A ceiling and the size that missed it are close together by construction -
 * the search stops at the first size over the line - so the default precision
 * routinely lands both on the same string. "cannot reach 14 KB without
 * dropping below quality 40 (best: 14 KB at quality 40)" reads as a bug in
 * Rasterwright rather than a fact about the image, which is exactly the kind
 * of failure message that trains someone to stop reading them. Found on a
 * 13.6 KB ceiling missed by 322 bytes.
 *
 * Precision widens until the two differ, and falls back to exact bytes, which
 * always do unless the numbers are genuinely equal.
 */
export function formatBytesPair(
  allowed: number,
  actual: number,
): { allowed: string; actual: string } {
  const wide = formatBytes(allowed);
  const narrow = formatBytes(actual);
  if (wide !== narrow) return { allowed: wide, actual: narrow };

  for (let places = 1; places <= 3; places += 1) {
    const a = formatBytes(allowed, places);
    const b = formatBytes(actual, places);
    if (a !== b) return { allowed: a, actual: b };
  }
  return { allowed: `${allowed} B`, actual: `${actual} B` };
}
