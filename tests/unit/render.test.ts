import { describe, expect, it } from 'vitest';

import { renderHuman } from '../../src/cli/render/human.js';
import { renderOperation } from '../../src/cli/render/plan.js';
import type {
  CheckReport,
  EncodeOperation,
  EncodeOutcome,
  FileResult,
  Finding,
  QualityBand,
} from '../../src/types.js';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    path: 'assets/a.png',
    rule: 'assets/**',
    check: 'metadata',
    severity: 'warning',
    actual: 'EXIF',
    allowed: 'none',
    fixable: 'yes',
    message: 'EXIF present; a future fix would remove it',
    ...overrides,
  };
}

function file(overrides: Partial<FileResult> = {}): FileResult {
  const findings = overrides.findings ?? [finding()];
  return {
    path: 'assets/a.png',
    status: 'warning',
    matchedGlobs: ['assets/**'],
    findings,
    fixable: 'yes',
    ...overrides,
  };
}

function report(files: FileResult[]): CheckReport {
  const all = files.flatMap((f) => f.findings);
  const has = (severity: string) => (f: FileResult) => f.findings.some((x) => x.severity === severity);
  return {
    rasterwrightVersion: '0.0.0-test',
    clean: !files.some(has('error')),
    configPath: '/repo/.rasterwright.yml',
    root: '/repo',
    summary: {
      checked: files.length,
      clean: files.filter((f) => f.status === 'clean' || f.status === 'info').length,
      withWarnings: files.filter(has('warning')).length,
      withErrors: files.filter(has('error')).length,
      errors: all.filter((f) => f.severity === 'error').length,
      warnings: all.filter((f) => f.severity === 'warning').length,
      infos: all.filter((f) => f.severity === 'info').length,
      unreadable: 0,
      ignored: 0,
    },
    files,
  };
}

/** The body of a finding line, with the leading indent stripped. */
function findingLines(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('    ') && line.trim() !== '')
    .map((line) => line.slice(4));
}

describe('column layout', () => {
  it('separates a short value from the text that follows it', () => {
    const output = renderHuman(report([file()]), { verbose: true });
    expect(findingLines(output)).toContain('metadata      EXIF              a fix would remove it');
  });

  it('never runs two fields together when the value overflows its column', () => {
    // Regression: padEnd is a no-op once the value is already wider than the
    // column, which produced "other ancillary metadataa fix would remove it".
    const long = finding({ actual: 'other ancillary metadata' });
    const output = renderHuman(report([file({ findings: [long] })]), { verbose: true });

    expect(output).not.toMatch(/metadataa fix/);
    expect(findingLines(output)).toEqual([
      'metadata      other ancillary metadata',
      '              a fix would remove it',
    ]);
  });

  it('wraps every overflowing value, whatever the check', () => {
    const wide = finding({
      check: 'colorSpace',
      severity: 'error',
      actual: 'Some Very Long Colour Profile Name',
      allowed: 'sRGB',
      message: 'not sRGB',
    });
    const output = renderHuman(report([file({ status: 'error', findings: [wide] })]));
    expect(findingLines(output)).toEqual([
      'colorSpace    Some Very Long Colour Profile Name',
      '              expected: sRGB',
    ]);
  });

  it('emits one line when there is nothing in the third column', () => {
    const solo = finding({
      check: 'animated',
      severity: 'info',
      actual: null,
      allowed: null,
      fixable: 'n/a',
      message: 'is animated; v0 does not transform animated images',
    });
    const output = renderHuman(report([file({ status: 'info', findings: [solo] })]), { verbose: true });
    expect(findingLines(output)).toEqual(['animated      is animated; v0 does not transform animated images']);
  });
});

describe('sections', () => {
  it('shows errors individually and summarizes warnings', () => {
    const files = [
      file({
        path: 'assets/big.jpg',
        status: 'error',
        findings: [
          finding({
            path: 'assets/big.jpg',
            check: 'maxWidth',
            severity: 'error',
            actual: 2000,
            allowed: 1200,
            message: '2000 px wide, allowed 1200 px',
          }),
        ],
      }),
      file({ path: 'assets/one.png' }),
      file({ path: 'assets/two.png', findings: [finding({ path: 'assets/two.png', actual: 'XMP' })] }),
    ];

    const output = renderHuman(report(files));
    expect(output).toMatch(/✗ assets\/big\.jpg/);
    expect(output).toMatch(/⚠ 2 images contain removable metadata/);
    expect(output).toMatch(/1 with EXIF/);
    expect(output).toMatch(/1 with XMP/);
    // Individual warning files stay collapsed until asked for.
    expect(output).not.toMatch(/⚠ assets\/one\.png/);
  });

  it('says "with" so overlapping subtype counts do not read as an error', () => {
    // One file can hold several kinds at once, so the subtypes sum to more than
    // the file count. Without "with", that looks like an arithmetic bug.
    const files = [
      file({ path: 'a.png', findings: [finding({ path: 'a.png', actual: 'EXIF, XMP, IPTC' })] }),
      file({ path: 'b.png', findings: [finding({ path: 'b.png', actual: 'EXIF, XMP' })] }),
      file({ path: 'c.png', findings: [finding({ path: 'c.png', actual: 'EXIF' })] }),
    ];

    const output = renderHuman(report(files));
    const lines = output.split('\n');
    const start = lines.findIndex((line) => line.startsWith('⚠'));
    const summary = lines.slice(start, lines.indexOf('', start));

    expect(summary).toEqual([
      '⚠ 3 images contain removable metadata',
      '    3 with EXIF',
      '    2 with XMP',
      '    1 with IPTC',
    ]);
  });

  it('right-aligns subtype counts of differing width', () => {
    const files = Array.from({ length: 11 }, (_, i) =>
      file({
        path: `f${i}.png`,
        findings: [finding({ path: `f${i}.png`, actual: i === 0 ? 'EXIF, XMP' : 'EXIF' })],
      }),
    );

    const output = renderHuman(report(files));
    expect(output).toMatch(/^ {4}11 with EXIF$/m);
    expect(output).toMatch(/^ {4} 1 with XMP$/m);
  });

  it('keeps the count line grammatical for a single file', () => {
    const output = renderHuman(report([file()]));
    expect(output).toMatch(/⚠ 1 image contains removable metadata/);
    expect(output).toMatch(/1 with EXIF/);
  });

  it('expands warnings under --verbose', () => {
    const files = [file({ path: 'assets/one.png' }), file({ path: 'assets/two.png' })];
    const output = renderHuman(report(files), { verbose: true });
    expect(output).toMatch(/⚠ assets\/one\.png/);
    expect(output).toMatch(/⚠ assets\/two\.png/);
    expect(output).not.toMatch(/Run with --verbose/);
  });

  it('says so plainly when there is nothing to report', () => {
    const output = renderHuman(report([file({ path: 'assets/ok.png', status: 'clean', findings: [] })]));
    expect(output).toMatch(/No errors or warnings\./);
    expect(output).not.toMatch(/ERRORS|WARNINGS/);
  });
});

/**
 * The `quality` row is the one line the plan report and the fix report cannot
 * say the same way, so it gets its own tests rather than being inferred from a
 * whole-report snapshot.
 */
describe('the quality row', () => {
  const band: QualityBand = { start: 82, floor: 40 };

  function encodeOperation(maxBytes?: number): EncodeOperation {
    const operation: EncodeOperation = {
      op: 'encode',
      format: 'jpeg',
      budgetDriven: maxBytes !== undefined,
      quality: band,
      stripMetadata: true,
      preserveAlpha: false,
      lossyReencode: true,
      outcomeRequiresVerification: maxBytes !== undefined,
      preservesOrientation: false,
    };
    if (maxBytes !== undefined) operation.maxBytes = maxBytes;
    return operation;
  }

  function qualityRow(operation: EncodeOperation, executed?: { encoded?: EncodeOutcome }): string {
    const row = renderOperation(operation, executed).find((line) => line.startsWith('quality'));
    if (row === undefined) throw new Error('no quality row was rendered');
    return row.replace(/^quality\s+/, '');
  }

  it('describes the band a plan would search', () => {
    expect(qualityRow(encodeOperation(204_800))).toBe('82, searched down to 40 if needed');
  });

  it('names one number when a plan has no ceiling to search against', () => {
    expect(qualityRow(encodeOperation())).toBe('82');
  });

  it('names where a finished search landed, and the range it covered', () => {
    const encoded: EncodeOutcome = {
      format: 'jpeg',
      bytes: 197_353,
      quality: { start: 82, chosen: 72, floor: 40, searched: true, attempts: 6 },
    };
    expect(qualityRow(encodeOperation(204_800), { encoded })).toBe('82 -> 72 (searched 40-81)');
  });

  it('names one number for a finished encode that searched nothing', () => {
    // The discipline the `searched` flag exists for: printing a range over a
    // single encode would describe work that did not happen.
    const encoded: EncodeOutcome = {
      format: 'jpeg',
      bytes: 30_455,
      quality: { start: 82, chosen: 82, floor: 40, searched: false, attempts: 1 },
    };
    expect(qualityRow(encodeOperation(204_800), { encoded })).toBe('82');
  });

  it('falls back to the start quality for a file nothing encoded', () => {
    // A skipped or blocked file still shows its plan, and that plan must not
    // claim a search on the strength of having a ceiling.
    expect(qualityRow(encodeOperation(204_800), {})).toBe('82');
  });
});
