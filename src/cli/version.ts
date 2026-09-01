import fs from 'node:fs';

/**
 * Read the package version.
 *
 * `src/cli/` and `dist/cli/` are both two levels below the package root, so one
 * relative URL covers development and the built CLI.
 */
export function readVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url);
    const pkg: unknown = JSON.parse(fs.readFileSync(url, 'utf8'));
    if (typeof pkg === 'object' && pkg !== null && typeof (pkg as { version?: unknown }).version === 'string') {
      return (pkg as { version: string }).version;
    }
  } catch {
    // Fall through to the placeholder.
  }
  return '0.0.0';
}
