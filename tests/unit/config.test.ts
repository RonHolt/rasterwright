import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findConfig, loadConfig, loadConfigFile } from '../../src/config/load.js';
import { parsePolicy } from '../../src/config/schema.js';
import { ConfigError } from '../../src/utils/errors.js';
import { parse as parseYaml } from 'yaml';

const dirs: string[] = [];

function projectWith(config: string, filename = '.rasterwright.yml'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rasterwright-config-')));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, filename), config);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function policyFrom(yaml: string) {
  return parsePolicy(parseYaml(yaml));
}

const MINIMAL = `
version: 1
rules:
  "assets/**": { maxWidth: 100 }
`;

describe('parsePolicy', () => {
  it('parses a full config and normalizes byte units', () => {
    const policy = policyFrom(`
version: 1
defaults:
  stripMetadata: true
  colorSpace: srgb
rules:
  "assets/**/*.{jpg,jpeg,png,webp}":
    maxWidth: 2400
    maxBytes: 500kb
  "assets/heroes/**":
    maxWidth: 2400
    maxBytes: 400kb
    format: webp
`);

    expect(policy.version).toBe(1);
    expect(policy.defaults).toEqual({
      upscale: false,
      stripMetadata: true,
      autoOrient: true,
      colorSpace: 'srgb',
    });
    expect(policy.rules.map((rule) => rule.glob)).toEqual([
      'assets/**/*.{jpg,jpeg,png,webp}',
      'assets/heroes/**',
    ]);
    expect(policy.rules[0]!.body.maxBytes).toBe(512_000);
    expect(policy.rules[1]!.body).toEqual({ maxWidth: 2400, maxBytes: 409_600, format: 'webp' });
  });

  it('applies built-in defaults when the config omits a defaults block', () => {
    expect(policyFrom(MINIMAL).defaults).toEqual({
      upscale: false,
      stripMetadata: true,
      autoOrient: true,
      colorSpace: 'srgb',
    });
  });

  it('lets the config override built-in defaults', () => {
    const policy = policyFrom(`
version: 1
defaults:
  stripMetadata: false
rules:
  "assets/**": { maxWidth: 100 }
`);
    expect(policy.defaults.stripMetadata).toBe(false);
  });

  it('defaults autoOrient to true and lets a rule turn it off', () => {
    expect(policyFrom(MINIMAL).defaults.autoOrient).toBe(true);
    const policy = policyFrom(`
version: 1
rules:
  "scans/**": { autoOrient: false }
`);
    expect(policy.rules[0]!.body.autoOrient).toBe(false);
  });

  it('normalizes jpg to jpeg', () => {
    const policy = policyFrom(`
version: 1
rules:
  "a/**": { format: jpg }
`);
    expect(policy.rules[0]!.body.format).toBe('jpeg');
  });

  it('keeps quality.start as a ceiling and rejects a floor above it', () => {
    const policy = policyFrom(`
version: 1
rules:
  "a/**": { quality: { start: 82, floor: 40 } }
`);
    expect(policy.rules[0]!.body.quality).toEqual({ start: 82, floor: 40 });

    expect(() =>
      policyFrom(`
version: 1
rules:
  "a/**": { quality: { start: 40, floor: 82 } }
`),
    ).toThrow(/floor \(82\) is above start \(40\)/);
  });
});

describe('invalid config', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['empty document', '', /config is empty/],
    ['not a mapping', '- one\n- two', /must be a YAML mapping/],
    ['missing version', 'rules:\n  "a/**": { maxWidth: 1 }', /version: missing/],
    ['wrong version', 'version: 2\nrules:\n  "a/**": { maxWidth: 1 }', /unsupported config version/],
    ['missing rules', 'version: 1', /rules: missing/],
    ['empty rules', 'version: 1\nrules: {}', /at least one rule/],
    ['rules not a mapping', 'version: 1\nrules: [a, b]', /expected a mapping/],
    ['unknown top-level key', 'version: 1\nrules:\n  "a/**": {}\nnope: 1', /unknown top-level key/],
    ['unknown property', 'version: 1\nrules:\n  "a/**": { maxWide: 1 }', /unknown policy property/],
    ['bad maxWidth', 'version: 1\nrules:\n  "a/**": { maxWidth: 0 }', /positive whole number/],
    ['bad maxWidth type', 'version: 1\nrules:\n  "a/**": { maxWidth: wide }', /positive whole number/],
    ['bad format', 'version: 1\nrules:\n  "a/**": { format: avif }', /expected one of jpeg, png, webp/],
    ['bad colorSpace', 'version: 1\nrules:\n  "a/**": { colorSpace: p3 }', /only 'srgb' is supported/],
    ['bad stripMetadata', 'version: 1\nrules:\n  "a/**": { stripMetadata: yep }', /expected true or false/],
    ['bad autoOrient', 'version: 1\nrules:\n  "a/**": { autoOrient: sometimes }', /expected true or false/],
    ['upscale true', 'version: 1\nrules:\n  "a/**": { upscale: true }', /upscaling is not supported/],
    ['bad maxBytes', 'version: 1\nrules:\n  "a/**": { maxBytes: enormous }', /could not parse/],
  ];

  for (const [name, yaml, expected] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => policyFrom(yaml)).toThrow(ConfigError);
      expect(() => policyFrom(yaml)).toThrow(expected);
    });
  }
});

describe('loadConfig', () => {
  it('loads the nearest config, searching upwards', () => {
    const root = projectWith(MINIMAL);
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });

    const loaded = loadConfig(nested);
    expect(loaded.root).toBe(fs.realpathSync(root));
    expect(loaded.policy.rules).toHaveLength(1);
  });

  it('accepts the .yaml spelling', () => {
    const root = projectWith(MINIMAL, '.rasterwright.yaml');
    expect(findConfig(root)).toBe(path.join(root, '.rasterwright.yaml'));
  });

  it('reports invalid YAML with the file path', () => {
    const root = projectWith('version: 1\nrules:\n  "a/**":\n    maxWidth: 1\n   bad: indent\n');
    expect(() => loadConfig(root)).toThrow(/is not valid YAML/);
  });

  it('prefixes schema errors with the config path', () => {
    const root = projectWith('version: 3\nrules:\n  "a/**": {}\n');
    expect(() => loadConfig(root)).toThrow(new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('fails when there is no config anywhere above', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rasterwright-empty-')));
    dirs.push(root);
    // The temp directory has no config; searching upwards must not find one either.
    const anyAbove = findConfig(root);
    if (anyAbove === undefined) {
      expect(() => loadConfig(root)).toThrow(/no \.rasterwright\.yml found/);
    }
  });

  it('uses an explicit config path verbatim', () => {
    const root = projectWith(MINIMAL);
    const loaded = loadConfigFile(path.join(root, '.rasterwright.yml'));
    expect(loaded.configPath).toBe(path.join(root, '.rasterwright.yml'));
  });

  it('fails when an explicit config path does not exist', () => {
    const root = projectWith(MINIMAL);
    expect(() => loadConfig(root, 'nope.yml')).toThrow(/config not found/);
  });
});
