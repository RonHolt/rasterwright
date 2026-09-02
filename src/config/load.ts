import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';

import { ConfigError } from '../utils/errors.js';
import { parsePolicy } from './schema.js';
import type { Policy } from '../types.js';

export const CONFIG_FILENAME = '.rasterwright.yml';
/** Accepted alternate spelling. Both are looked for in the same directory. */
export const CONFIG_FILENAME_ALT = '.rasterwright.yaml';

export interface LoadedConfig {
  /** Absolute path to the config file. */
  configPath: string;
  /** Absolute path to the directory containing it. This is the project root. */
  root: string;
  policy: Policy;
}

/**
 * Walk up from `startDir` looking for a config file.
 *
 * Returns the absolute path, or undefined if none is found before the
 * filesystem root.
 */
export function findConfig(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of [CONFIG_FILENAME, CONFIG_FILENAME_ALT]) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Parse and validate config text that need not be on disk.
 *
 * Split out of `loadConfigFile` so `init` can validate the file it is about to
 * write through this exact code path, before writing it. Validating after the
 * write would mean a generated config the loader rejects still lands in the
 * user's repository, and validating through a second, parallel parser would
 * mean the check drifts from the thing it is checking.
 *
 * @param label - what to name the source in errors: a path, or `<generated>`.
 */
export function parseConfigText(text: string, label: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const detail = error instanceof YAMLParseError ? error.message : (error as Error).message;
    throw new ConfigError(`${label} is not valid YAML: ${detail}`);
  }

  try {
    return parsePolicy(raw);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new ConfigError(`${label}: ${error.message}`, error.hint);
    }
    throw error;
  }
}

/** Parse and validate a config file. The project root is the file's directory. */
export function loadConfigFile(configPath: string): LoadedConfig {
  const absolute = path.resolve(configPath);

  let text: string;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new ConfigError(`could not read ${absolute}: ${(error as Error).message}`);
  }

  return { configPath: absolute, root: path.dirname(absolute), policy: parseConfigText(text, absolute) };
}

/**
 * Locate and load the config governing `startDir`.
 *
 * @param explicitPath - an explicit `--config` path, which is used verbatim.
 */
export function loadConfig(startDir: string, explicitPath?: string): LoadedConfig {
  if (explicitPath !== undefined) {
    const absolute = path.resolve(startDir, explicitPath);
    if (!fs.existsSync(absolute)) {
      throw new ConfigError(`config not found: ${absolute}`);
    }
    return loadConfigFile(absolute);
  }

  const found = findConfig(startDir);
  if (found === undefined) {
    throw new ConfigError(
      `no ${CONFIG_FILENAME} found in ${path.resolve(startDir)} or any parent directory`,
      'Create one at your project root. See the README for a starting example.',
    );
  }
  return loadConfigFile(found);
}
