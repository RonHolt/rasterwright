import { describe, expect, it } from 'vitest';

import { formatBytes, formatBytesPair, parseBytes } from '../../src/utils/bytes.js';
import { ConfigError } from '../../src/utils/errors.js';

describe('parseBytes', () => {
  it('treats kb/KB/KiB as 1024 bytes', () => {
    expect(parseBytes('500kb', 'x')).toBe(512_000);
    expect(parseBytes('500KB', 'x')).toBe(512_000);
    expect(parseBytes('500 KiB', 'x')).toBe(512_000);
    expect(parseBytes('500k', 'x')).toBe(512_000);
  });

  it('treats mb as 1024 * 1024 bytes', () => {
    expect(parseBytes('1mb', 'x')).toBe(1_048_576);
    expect(parseBytes('1MB', 'x')).toBe(1_048_576);
    expect(parseBytes('0.5mb', 'x')).toBe(524_288);
  });

  it('accepts plain byte counts, as numbers or strings', () => {
    expect(parseBytes(512_000, 'x')).toBe(512_000);
    expect(parseBytes('512000', 'x')).toBe(512_000);
    expect(parseBytes('512000b', 'x')).toBe(512_000);
  });

  it('rounds fractional results to whole bytes', () => {
    expect(parseBytes('1.5kb', 'x')).toBe(1536);
    expect(parseBytes('0.001kb', 'x')).toBe(1);
  });

  it('rejects values it cannot parse', () => {
    expect(() => parseBytes('big', 'rules["a"].maxBytes')).toThrow(ConfigError);
    expect(() => parseBytes('500 parsecs', 'x')).toThrow(/unknown byte unit/);
    expect(() => parseBytes(0, 'x')).toThrow(/positive/);
    expect(() => parseBytes(-1, 'x')).toThrow(/positive/);
    expect(() => parseBytes(1.5, 'x')).toThrow(/whole number/);
    expect(() => parseBytes(true, 'x')).toThrow(ConfigError);
    expect(() => parseBytes('0kb', 'x')).toThrow(/greater than zero/);
  });

  it('names the offending config path in the error', () => {
    expect(() => parseBytes('nope', 'rules["assets/**"].maxBytes')).toThrow(/rules\["assets\/\*\*"\]\.maxBytes/);
  });
});

describe('formatBytes', () => {
  it('formats on the same 1024 basis it parses', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(512_000)).toBe('500 KB');
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(8_178_892)).toBe('7.8 MB');
  });

  it('round-trips through parseBytes', () => {
    expect(parseBytes(formatBytes(512_000).replace(' ', ''), 'x')).toBe(512_000);
    expect(parseBytes(formatBytes(1_048_576).replace(' ', ''), 'x')).toBe(1_048_576);
  });
});

describe('formatBytesPair', () => {
  it('leaves counts alone when the default precision already tells them apart', () => {
    expect(formatBytesPair(15_360, 84_000)).toEqual({ allowed: '15 KB', actual: '82 KB' });
  });

  it('widens precision when a ceiling and the size that missed it collide', () => {
    // The real case: a 13.6 KB ceiling missed by 322 bytes, where both counts
    // print as "14 KB" and the failure message reads as a contradiction.
    expect(formatBytesPair(13_926, 14_248)).toEqual({ allowed: '13.6 KB', actual: '13.9 KB' });
  });

  it('falls back to exact bytes when even three decimals collide', () => {
    expect(formatBytesPair(1_048_576, 1_048_577)).toEqual({
      allowed: '1048576 B',
      actual: '1048577 B',
    });
  });
});
