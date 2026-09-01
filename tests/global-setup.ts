import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateFixtures } from '../scripts/generate-fixtures.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Fixture images are generated rather than committed, so make sure they exist
 * before any test runs. Generation is deterministic and takes well under a
 * second, so it is unconditional rather than cached.
 */
export default async function setup(): Promise<void> {
  await generateFixtures();
  const sentinel = path.join(REPO_ROOT, 'fixtures', 'images', 'compliant.jpg');
  if (!fs.existsSync(sentinel)) {
    throw new Error(`fixture generation failed: ${sentinel} is missing`);
  }
}
