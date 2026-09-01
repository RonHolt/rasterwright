/**
 * A deliberately small, best-effort ICC profile reader.
 *
 * Sharp hands us the raw profile bytes but does not interpret them. All we
 * want is enough to answer "is this image tagged sRGB?" without pulling in a
 * colour-management dependency. Anything we cannot read confidently comes back
 * as `undefined` and is reported as `colorSpaceStatus: 'unknown'` rather than
 * being guessed at.
 *
 * Reference: ICC.1:2010, sections 7.2 (header) and 7.3 (tag table).
 */

export interface IccSummary {
  /** The profile's `desc` tag, when it could be read. */
  description: string | undefined;
  /** Header data colour space signature, trimmed: 'RGB', 'CMYK', 'GRAY', ... */
  dataColorSpace: string | undefined;
}

const HEADER_SIZE = 128;

export function readIccSummary(icc: Buffer): IccSummary {
  const empty: IccSummary = { description: undefined, dataColorSpace: undefined };
  if (icc.length < HEADER_SIZE + 4) return empty;

  const dataColorSpace = icc.toString('latin1', 16, 20).trim() || undefined;

  let description: string | undefined;
  try {
    const tagCount = icc.readUInt32BE(HEADER_SIZE);
    // A sane profile has a handful of tags. Anything wild means we misread it.
    if (tagCount > 0 && tagCount < 1024) {
      for (let i = 0; i < tagCount; i += 1) {
        const entry = HEADER_SIZE + 4 + i * 12;
        if (entry + 12 > icc.length) break;
        if (icc.toString('latin1', entry, entry + 4) !== 'desc') continue;
        const offset = icc.readUInt32BE(entry + 4);
        const size = icc.readUInt32BE(entry + 8);
        if (offset + size > icc.length || size < 12) break;
        description = readDescTag(icc, offset, size);
        break;
      }
    }
  } catch {
    description = undefined;
  }

  return { description, dataColorSpace };
}

function readDescTag(icc: Buffer, offset: number, size: number): string | undefined {
  const type = icc.toString('latin1', offset, offset + 4);

  // ICC v2 textDescriptionType: 'desc', reserved, uint32 ascii length, ascii bytes.
  if (type === 'desc') {
    const length = icc.readUInt32BE(offset + 8);
    if (length === 0 || offset + 12 + length > icc.length) return undefined;
    return clean(icc.toString('latin1', offset + 12, offset + 12 + length));
  }

  // ICC v4 multiLocalizedUnicodeType: records of UTF-16BE strings. Take the first.
  if (type === 'mluc') {
    // Layout: 'mluc', reserved, uint32 record count, uint32 record size, then
    // records of { language[2], country[2], uint32 length, uint32 offset }.
    const recordCount = icc.readUInt32BE(offset + 8);
    if (recordCount === 0) return undefined;
    const recordLength = icc.readUInt32BE(offset + 20);
    const recordOffset = icc.readUInt32BE(offset + 24);
    const start = offset + recordOffset;
    if (recordLength === 0 || recordLength % 2 !== 0 || start + recordLength > icc.length) {
      return undefined;
    }
    // UTF-16BE on the wire; Node only decodes LE, so copy and byte-swap.
    const utf16be = Buffer.from(icc.subarray(start, start + recordLength));
    return clean(utf16be.swap16().toString('utf16le'));
  }

  // Some encoders use plain 'text'. Cheap enough to support.
  if (type === 'text') {
    return clean(icc.toString('latin1', offset + 8, offset + size));
  }

  return undefined;
}

function clean(value: string): string | undefined {
  const trimmed = value.replace(/\0+$/, '').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Does this profile describe sRGB?
 *
 * Conservative on purpose: a profile we cannot name is not sRGB *and* not
 * confidently something else, so callers should treat `false` here as
 * "unknown", not as "non-compliant".
 */
export function looksLikeSrgb(summary: IccSummary): boolean {
  const description = summary.description;
  if (!description) return false;
  return /\bs\s?rgb\b/i.test(description.replace(/[-_]/g, ' '));
}
