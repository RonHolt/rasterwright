import { createHash } from 'node:crypto';

/** sha256 of a buffer, hex encoded. */
export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}
