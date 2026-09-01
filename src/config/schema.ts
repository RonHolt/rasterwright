import { ConfigError } from '../utils/errors.js';
import { parseBytes } from '../utils/bytes.js';
import type { ImageFormat, Policy, Rule, RuleBody } from '../types.js';

/**
 * Validation for `.rasterwright.yml` version 1.
 *
 * Hand-written rather than schema-library-driven. The schema is a dozen keys
 * with unusual coercion rules (byte units), and the error messages matter more
 * than the terseness of the declaration.
 */

export const SUPPORTED_FORMATS: readonly ImageFormat[] = ['jpeg', 'png', 'webp'];

/** Extensions Rasterwright will discover and inspect. */
export const SUPPORTED_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png', 'webp'];

/** Aliases accepted for `format:` so `jpg` does not surprise anyone. */
const FORMAT_ALIASES: Record<string, ImageFormat> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  webp: 'webp',
};

/**
 * Policy applied before the config's own `defaults` block.
 *
 * These match the documented `defaults` in the scope document. `upscale` is
 * always false in v0; the key exists so the schema stays stable.
 */
export const BUILT_IN_DEFAULTS: RuleBody = {
  upscale: false,
  stripMetadata: true,
  autoOrient: true,
  colorSpace: 'srgb',
};

/** Default quality band for the future encoder. `start` is a ceiling, not a target. */
export const DEFAULT_QUALITY = { start: 82, floor: 40 } as const;

const RULE_BODY_KEYS = new Set([
  'maxWidth',
  'maxHeight',
  'maxBytes',
  'format',
  'upscale',
  'stripMetadata',
  'autoOrient',
  'colorSpace',
  'quality',
]);

const TOP_LEVEL_KEYS = new Set(['version', 'defaults', 'rules']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requirePositiveInteger(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${where}: expected a positive whole number, got ${JSON.stringify(value)}`);
  }
  return value;
}

function requireBoolean(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${where}: expected true or false, got ${JSON.stringify(value)}`);
  }
  return value;
}

function parseFormat(value: unknown, where: string): ImageFormat {
  if (typeof value !== 'string' || !(value.toLowerCase() in FORMAT_ALIASES)) {
    throw new ConfigError(
      `${where}: expected one of ${SUPPORTED_FORMATS.join(', ')}, got ${JSON.stringify(value)}`,
    );
  }
  return FORMAT_ALIASES[value.toLowerCase()]!;
}

function parseQuality(value: unknown, where: string): RuleBody['quality'] {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${where}: expected a mapping with 'start' and 'floor'`);
  }
  for (const key of Object.keys(value)) {
    if (key !== 'start' && key !== 'floor') {
      throw new ConfigError(`${where}.${key}: unknown key`, `Known keys: start, floor.`);
    }
  }
  const start = value.start === undefined ? DEFAULT_QUALITY.start : requirePositiveInteger(value.start, `${where}.start`);
  const floor = value.floor === undefined ? DEFAULT_QUALITY.floor : requirePositiveInteger(value.floor, `${where}.floor`);
  if (start > 100 || floor > 100) {
    throw new ConfigError(`${where}: quality values must be between 1 and 100`);
  }
  if (floor > start) {
    throw new ConfigError(
      `${where}: floor (${floor}) is above start (${start})`,
      'start is the maximum quality Rasterwright will encode at; floor is the lowest it may fall to.',
    );
  }
  return { start, floor };
}

export function parseRuleBody(raw: unknown, where: string): RuleBody {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${where}: expected a mapping of policy properties`);
  }

  for (const key of Object.keys(raw)) {
    if (!RULE_BODY_KEYS.has(key)) {
      throw new ConfigError(
        `${where}.${key}: unknown policy property`,
        `Known properties: ${[...RULE_BODY_KEYS].join(', ')}.`,
      );
    }
  }

  const body: RuleBody = {};

  if (raw.maxWidth !== undefined) body.maxWidth = requirePositiveInteger(raw.maxWidth, `${where}.maxWidth`);
  if (raw.maxHeight !== undefined) body.maxHeight = requirePositiveInteger(raw.maxHeight, `${where}.maxHeight`);
  if (raw.maxBytes !== undefined) body.maxBytes = parseBytes(raw.maxBytes, `${where}.maxBytes`);
  if (raw.format !== undefined) body.format = parseFormat(raw.format, `${where}.format`);
  if (raw.upscale !== undefined) {
    const upscale = requireBoolean(raw.upscale, `${where}.upscale`);
    if (upscale) {
      throw new ConfigError(
        `${where}.upscale: upscaling is not supported`,
        'Rasterwright never enlarges an image. Remove the key or set it to false.',
      );
    }
    body.upscale = false;
  }
  if (raw.stripMetadata !== undefined) {
    body.stripMetadata = requireBoolean(raw.stripMetadata, `${where}.stripMetadata`);
  }
  if (raw.autoOrient !== undefined) {
    body.autoOrient = requireBoolean(raw.autoOrient, `${where}.autoOrient`);
  }
  if (raw.colorSpace !== undefined) {
    if (raw.colorSpace !== 'srgb') {
      throw new ConfigError(
        `${where}.colorSpace: only 'srgb' is supported in v0, got ${JSON.stringify(raw.colorSpace)}`,
      );
    }
    body.colorSpace = 'srgb';
  }
  if (raw.quality !== undefined) body.quality = parseQuality(raw.quality, `${where}.quality`);

  return body;
}

/** Validate a parsed YAML document and normalize it into a `Policy`. */
export function parsePolicy(raw: unknown): Policy {
  if (raw === null || raw === undefined) {
    throw new ConfigError('config is empty', 'A minimal config needs `version: 1` and a `rules:` block.');
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError('config must be a YAML mapping at the top level');
  }

  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      throw new ConfigError(`${key}: unknown top-level key`, `Known keys: ${[...TOP_LEVEL_KEYS].join(', ')}.`);
    }
  }

  if (raw.version === undefined) {
    throw new ConfigError('version: missing', 'Add `version: 1` to the top of the file.');
  }
  if (raw.version !== 1) {
    throw new ConfigError(
      `version: unsupported config version ${JSON.stringify(raw.version)}`,
      'This build of Rasterwright understands version 1.',
    );
  }

  const defaults: RuleBody = {
    ...BUILT_IN_DEFAULTS,
    ...(raw.defaults === undefined ? {} : parseRuleBody(raw.defaults, 'defaults')),
  };

  if (raw.rules === undefined) {
    throw new ConfigError(
      'rules: missing',
      'Without rules nothing is governed and `check` has nothing to do.',
    );
  }
  if (!isPlainObject(raw.rules)) {
    throw new ConfigError('rules: expected a mapping of glob -> policy properties');
  }

  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (const [glob, value] of Object.entries(raw.rules)) {
    if (glob.trim() === '') {
      throw new ConfigError('rules: a rule glob may not be empty');
    }
    if (seen.has(glob)) {
      throw new ConfigError(`rules["${glob}"]: duplicate glob`);
    }
    seen.add(glob);
    rules.push({ glob, body: parseRuleBody(value, `rules["${glob}"]`) });
  }

  if (rules.length === 0) {
    throw new ConfigError(
      'rules: at least one rule is required',
      'Without rules nothing is governed and `check` has nothing to do.',
    );
  }

  return { version: 1, defaults, rules };
}
