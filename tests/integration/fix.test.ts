import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { inspect } from '../../src/scanner/inspect.js';
import {
  cleanupProjects,
  copyGitProject,
  copyProject,
  FIXTURE_IMAGES,
  hashTree,
  initGitRepo,
  residue,
  runCli,
  spawnCli,
} from '../helpers/project.js';
import { snapshotDirs, snapshotTree } from '../helpers/snapshot.js';
import type { FixReport } from '../../src/types.js';

afterAll(cleanupProjects);

/**
 * `rasterwright fix`, executing.
 *
 * Every test here runs the real CLI as a child process against a copy of a
 * fixture project, because the properties worth proving are properties of a
 * process: the exit code, the separation of stdout from stderr, what is left on
 * disk after a crash, and what a signal does to a run in flight.
 *
 * `copyProject` copies into the system temp directory, which is outside any
 * repository, so a test that does not pass `--no-git` has to make one first.
 * That is what `copyGitProject` is for, and the distinction is load-bearing:
 * `fix` refusing outside a repository is one of the behaviours under test.
 */

const scratchDirs: string[] = [];

function scratchDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rasterwright-${label}-`));
  scratchDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function exists(root: string, ...parts: string[]): boolean {
  return fs.existsSync(path.join(root, ...parts));
}

async function jsonReport(root: string, args: string[]): Promise<FixReport> {
  const result = await runCli(['fix', '--json', ...args], root);
  return JSON.parse(result.stdout) as FixReport;
}

describe('fix on a mixed project', () => {
  it('fixes what it planned and leaves everything else byte-identical', async () => {
    const root = copyGitProject('mixed');
    const before = hashTree(root);

    const result = await runCli(['fix', '--allow-renames'], root);

    // icons/logo.png wants a JPEG it cannot become, so the run legitimately
    // exits 1 with work still outstanding.
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^Rasterwright Fix$/m);
    // Warning-only files are counted apart from the genuinely compliant ones,
    // as the plan report counts them, so neither number over-claims.
    expect(result.stdout).toMatch(/2 warning-only files left unchanged/);
    expect(result.stdout).toMatch(/6 already compliant/);

    const after = hashTree(root);
    const changed = [...after].filter(([file, hash]) => before.get(file) !== hash).map(([file]) => file);
    expect(changed.sort()).toEqual([
      'assets/cmyk.jpg',
      'assets/heavy.jpg',
      'assets/heroes/hero.webp',
      'assets/logo-webp.webp',
      'assets/oversized.jpg',
      'assets/rotated.jpg',
    ]);

    // Files nobody planned anything for are untouched, including the ungoverned
    // one and the two that carry warnings only.
    for (const file of ['assets/compliant.jpg', 'assets/exif.jpg', 'assets/xmp.png', 'ungoverned/stray.png']) {
      expect(after.get(file)).toBe(before.get(file));
    }
    expect(residue(root)).toEqual([]);
  });

  it('resizes an oversized image to the planned dimensions', async () => {
    const root = copyGitProject('mixed');
    await runCli(['fix', '--allow-renames'], root);

    const inspected = await inspect(root, 'assets/oversized.jpg');
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.info.width).toBe(1200);
    expect(inspected.info.height).toBe(720);
  });

  it('converts CMYK to sRGB and strips the metadata the rewrite made disposable', async () => {
    const root = copyGitProject('mixed');
    await runCli(['fix', '--allow-renames'], root);

    const cmyk = await inspect(root, 'assets/cmyk.jpg');
    expect(cmyk.ok).toBe(true);
    if (!cmyk.ok) return;
    expect(cmyk.info.colorSpaceStatus).toBe('srgb');
    expect(cmyk.info.pixelColorSpace).not.toMatch(/cmyk/);

    const rotated = await inspect(root, 'assets/rotated.jpg');
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    // autoOrient applied: the flag is cleared and the displayed size is stored.
    expect(rotated.info.orientation).toBe(1);
    expect(rotated.info.width).toBe(400);
    expect(rotated.info.height).toBe(600);
    expect(rotated.info.hasExif).toBe(false);
  });

  it('leaves every filename alone without --allow-renames', async () => {
    const root = copyGitProject('mixed');
    const result = await runCli(['fix'], root);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/rerun with --allow-renames/);
    expect(exists(root, 'assets', 'logo-webp.png')).toBe(true);
    expect(exists(root, 'assets', 'logo-webp.webp')).toBe(false);
    expect(exists(root, 'assets', 'heroes', 'hero.jpg')).toBe(true);
    expect(exists(root, 'assets', 'heroes', 'hero.webp')).toBe(false);
  });

  it('brings a budget-driven file under its ceiling by searching quality down', async () => {
    const root = copyGitProject('mixed');
    const report = await jsonReport(root, ['--allow-renames']);

    const heavy = report.results.find((entry) => entry.path === 'assets/heavy.jpg');
    expect(heavy?.status).toBe('fixed');
    expect(heavy?.after?.bytes).toBeLessThanOrEqual(200 * 1024);
    expect(heavy?.before.bytes).toBeGreaterThan(200 * 1024);
    expect(heavy?.encode?.quality?.searched).toBe(true);
    expect(heavy?.encode?.quality?.chosen).toBeLessThan(heavy?.encode?.quality?.start ?? 0);

    // The dimensions are untouched: the search only ever turns the quality dial.
    expect(heavy?.after?.width).toBe(heavy?.before.width);
    expect(heavy?.after?.height).toBe(heavy?.before.height);
  });

  it('reports an unfixable transparency conflict as skipped, not attempted', async () => {
    const root = copyGitProject('mixed');
    const before = hashTree(root);
    const report = await jsonReport(root, ['--allow-renames']);

    const logo = report.results.find((entry) => entry.path === 'assets/icons/logo.png');
    expect(logo?.status).toBe('skipped');
    expect(logo?.reason).toMatch(/transparency/);
    expect(hashTree(root).get('assets/icons/logo.png')).toBe(before.get('assets/icons/logo.png'));
  });
});

describe('fix enforcing a byte budget', () => {
  /** The `budget` project, fixed once, with its report. */
  async function fixBudget(): Promise<{ root: string; report: FixReport }> {
    const root = copyGitProject('budget');
    return { root, report: await jsonReport(root, []) };
  }

  function resultFor(report: FixReport, path: string) {
    const found = report.results.find((entry) => entry.path === path);
    if (found === undefined) throw new Error(`no result for ${path}`);
    return found;
  }

  it('fixes what a quality search can reach and fails the rest explicitly', async () => {
    const { report } = await fixBudget();

    expect(report.summary.fixed).toBe(3);
    expect(report.summary.failed).toBe(2);
    expect(report.summary.unchanged).toBe(1);

    expect(resultFor(report, 'assets/heavy.jpg').status).toBe('fixed');
    expect(resultFor(report, 'assets/alpha.webp').status).toBe('fixed');
    expect(resultFor(report, 'assets/resized/wide.jpg').status).toBe('fixed');
    expect(resultFor(report, 'assets/noisy.png').status).toBe('failed');
    expect(resultFor(report, 'assets/impossible/tiny.jpg').status).toBe('failed');
  });

  it('searches only when the start quality overshoots', async () => {
    const { report } = await fixBudget();

    const searched = resultFor(report, 'assets/heavy.jpg').encode?.quality;
    expect(searched?.searched).toBe(true);
    expect(searched?.attempts).toBeGreaterThan(1);
    expect(searched?.attempts).toBeLessThanOrEqual(8);
    expect(searched?.chosen).toBeLessThan(searched?.start ?? 0);

    // The resize brings this one under the ceiling on its own, so the start
    // quality is kept and nothing is searched.
    const straight = resultFor(report, 'assets/resized/wide.jpg').encode?.quality;
    expect(straight).toEqual({ start: 82, chosen: 82, floor: 40, searched: false, attempts: 1 });
  });

  it('keeps transparency through the search', async () => {
    const { root, report } = await fixBudget();

    expect(resultFor(report, 'assets/alpha.webp').encode?.quality?.searched).toBe(true);
    const alpha = await inspect(root, 'assets/alpha.webp');
    expect(alpha.ok).toBe(true);
    if (!alpha.ok) return;
    expect(alpha.info.format).toBe('webp');
    expect(alpha.info.hasAlpha).toBe(true);
    expect(alpha.info.isOpaque).toBe(false);
    expect(alpha.info.bytes).toBeLessThanOrEqual(150 * 1024);
  });

  it('explains a PNG it cannot shrink, and leaves it byte-identical', async () => {
    const root = copyGitProject('budget');
    const before = hashTree(root);
    const report = await jsonReport(root, []);

    const png = resultFor(report, 'assets/noisy.png');
    expect(png.reason).toMatch(/PNG is lossless/);
    expect(png.reason).toMatch(/still over the 200 KB ceiling/);
    expect(png.after).toBeUndefined();
    expect(hashTree(root).get('assets/noisy.png')).toBe(before.get('assets/noisy.png'));
  });

  it('explains a ceiling the quality floor cannot reach', async () => {
    const root = copyGitProject('budget');
    const before = hashTree(root);
    const report = await jsonReport(root, []);

    const impossible = resultFor(report, 'assets/impossible/tiny.jpg');
    expect(impossible.reason).toMatch(/cannot reach 20 KB at 700x700/);
    expect(impossible.reason).toMatch(/without dropping below quality 40/);
    expect(impossible.reason).toMatch(/Raise maxBytes/);
    expect(impossible.encode?.quality?.chosen).toBe(40);
    expect(hashTree(root).get('assets/impossible/tiny.jpg')).toBe(
      before.get('assets/impossible/tiny.jpg'),
    );
  });

  it('never opens a file that is already under its budget', async () => {
    const root = copyGitProject('budget');
    const before = hashTree(root);
    const report = await jsonReport(root, []);

    expect(report.results.some((entry) => entry.path === 'assets/small.webp')).toBe(false);
    expect(hashTree(root).get('assets/small.webp')).toBe(before.get('assets/small.webp'));
  });

  it('reports the search in the human output, and only where one happened', async () => {
    const root = copyGitProject('budget');
    const result = await runCli(['fix'], root);

    expect(result.code).toBe(1);
    // `82 -> 72 (searched 40-81)` for the file that searched, a bare number for
    // the one that did not.
    expect(result.stdout).toMatch(/quality\s+82 -> \d+ \(searched 40-81\)/);
    expect(result.stdout).toMatch(/quality\s+82$/m);
    expect(result.stdout).toMatch(/FAILED/);
    expect(result.stdout).toMatch(/2 files failed/);
    expect(result.stdout).toMatch(/3 files fixed/);
    // The retired note about budgets being unimplemented is gone for good.
    expect(result.stdout).not.toMatch(/not enforced yet/);
  });

  it('leaves check with only the two files nothing could fix', async () => {
    const root = copyGitProject('budget');
    await runCli(['fix'], root);

    const check = await runCli(['check', '--json'], root);
    const report = JSON.parse(check.stdout) as { files: { path: string; status: string }[] };
    const failing = report.files.filter((file) => file.status === 'error').map((file) => file.path);

    expect(failing.sort()).toEqual(['assets/impossible/tiny.jpg', 'assets/noisy.png']);
  });

  it('writes nothing at all on a second run', async () => {
    // The strict form of 04 section 10 applied to the budget path: a file the
    // search brought under its ceiling is compliant, so the next run plans
    // nothing for it and no buffer reaches the disk.
    const root = copyGitProject('budget');
    expect((await runCli(['fix'], root)).code).toBe(1);
    const hashes = hashTree(root);

    const trace = path.join(scratchDir('trace'), 'writes.log');
    const second = await runCli(['fix', '--json'], root, { RASTERWRIGHT_TRACE_WRITES: trace });
    const report = JSON.parse(second.stdout) as FixReport;

    expect(fs.existsSync(trace)).toBe(false);
    expect(hashTree(root)).toEqual(hashes);
    expect(residue(root)).toEqual([]);

    // Only the two genuinely unreachable files are still reported, and the
    // three that were fixed are now counted as compliant.
    expect(report.summary.fixed).toBe(0);
    expect(report.summary.failed).toBe(2);
    expect(report.summary.unchanged).toBe(4);
  });

  it('is deterministic: two runs from the same source pick the same bytes', async () => {
    const first = copyGitProject('budget');
    const second = copyGitProject('budget');

    await runCli(['fix'], first);
    await runCli(['fix'], second);

    expect(hashTree(second)).toEqual(hashTree(first));
  });
});

describe('a conversion that moves the file under another rule', () => {
  it('meets the target rule ceiling, not the one the source matched', async () => {
    // `tighter/*.png` sets no ceiling; `tighter/*.webp` sets 100 KB. Planning
    // against the source rule would encode once at quality 82, come out over,
    // and report a reachable ceiling as a failure.
    const root = copyGitProject('crossrule');
    const report = await jsonReport(root, ['--allow-renames']);

    const tighter = report.results.find((entry) => entry.path === 'tighter/noisy.png');
    expect(tighter?.status).toBe('fixed');
    expect(tighter?.outputPath).toBe('tighter/noisy.webp');
    expect(tighter?.after?.bytes).toBeLessThanOrEqual(100 * 1024);
    expect(tighter?.encode?.quality?.searched).toBe(true);
    expect(tighter?.encode?.quality?.chosen).toBeLessThan(82);

    const check = await runCli(['check', '--json'], root);
    const files = (JSON.parse(check.stdout) as { files: { path: string; status: string }[] }).files;
    expect(files.find((file) => file.path === 'tighter/noisy.webp')?.status).not.toBe('error');
  });

  it('does not degrade a file to meet a ceiling the target rule relaxes', async () => {
    // `looser/*.png` sets 50 KB and `looser/*.webp` sets 400 KB. Searching down
    // to 50 KB would burn quality for a rule that stops applying, and would
    // then claim success against a ceiling nothing checks.
    const root = copyGitProject('crossrule');
    const report = await jsonReport(root, ['--allow-renames']);

    const looser = report.results.find((entry) => entry.path === 'looser/noisy.png');
    expect(looser?.status).toBe('fixed');
    expect(looser?.outputPath).toBe('looser/noisy.webp');
    expect(looser?.encode?.quality).toEqual({
      start: 82,
      chosen: 82,
      floor: 40,
      searched: false,
      attempts: 1,
    });
    expect(looser?.after?.bytes).toBeGreaterThan(50 * 1024);
    expect(looser?.after?.bytes).toBeLessThanOrEqual(400 * 1024);
  });

  it('names the governing glob in the dry run, and writes nothing', async () => {
    const root = copyGitProject('crossrule');
    const before = hashTree(root);

    const result = await runCli(['fix', '--dry-run', '--allow-renames'], root);

    expect(result.stdout).toMatch(/100 KB ceiling comes from tighter\/\*\.webp/);
    expect(result.stdout).toMatch(/400 KB ceiling comes from looser\/\*\.webp/);
    expect(hashTree(root)).toEqual(before);
  });
});

describe('fix reports a corrupt file and keeps going', () => {
  it('fails the one file, leaves it alone, and still exits 1', async () => {
    const root = copyGitProject('corrupt');
    const before = hashTree(root);

    const result = await runCli(['fix'], root);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/FAILED/);
    expect(result.stdout).toMatch(/could not decode image/);

    // The batch continued: the other file was processed and reported.
    const report = await jsonReport(root, []);
    expect(report.summary.checked).toBe(2);
    expect(report.summary.failed).toBe(1);
    expect(hashTree(root)).toEqual(before);
  });
});

describe('fix refuses a batch whose paths collide', () => {
  it('blocks every colliding plan and changes nothing', async () => {
    const root = copyGitProject('collisions');
    const files = snapshotTree(root);
    const dirs = snapshotDirs(root);

    const result = await runCli(['fix', '--allow-renames'], root);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/BLOCKED/);
    expect(snapshotTree(root)).toEqual(files);
    expect(snapshotDirs(root)).toEqual(dirs);
    expect(residue(root)).toEqual([]);
  });
});

describe('fix and the orientation flag', () => {
  it('normalizes, preserves and leaves alone, each where the policy says', async () => {
    const root = copyGitProject('autoorient');
    const before = hashTree(root);

    const result = await runCli(['fix'], root);
    expect(result.code).toBe(0);

    // autoOrient on: the pixels are rotated and the flag is cleared.
    const normalized = await inspect(root, 'normalized/rotated.jpg');
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.info.orientation).toBe(1);
    expect(normalized.info.width).toBe(400);

    // autoOrient off and nothing else wrong: not touched at all.
    expect(hashTree(root).get('kept/rotated.jpg')).toBe(before.get('kept/rotated.jpg'));

    // autoOrient off but a width limit forced a rewrite: the flag survives it,
    // the pixels are not rotated, and the result is inside the policy.
    const kept = await inspect(root, 'kept-oversized/rotated.jpg');
    expect(kept.ok).toBe(true);
    if (!kept.ok) return;
    expect(kept.info.orientation).toBe(6);
    expect(kept.info.width).toBeLessThanOrEqual(300);
    expect(kept.info.storedWidth).toBeGreaterThan(kept.info.storedHeight);
  });

  it('writes nothing on a second run, despite the EXIF block it just added', async () => {
    // The preserved flag means a file that had no EXIF now has a minimal block,
    // which the next check reports as a metadata warning. Warnings never justify
    // a rewrite, so the second run has to be a no-op. This is the property 04
    // section 17.1 predicts and the one most worth pinning down.
    const root = copyGitProject('autoorient');
    expect((await runCli(['fix'], root)).code).toBe(0);

    const afterFirst = hashTree(root);
    expect((await runCli(['check'], root)).code).toBe(0);

    const trace = path.join(scratchDir('trace'), 'writes.log');
    const second = await runCli(['fix'], root, { RASTERWRIGHT_TRACE_WRITES: trace });

    expect(second.code).toBe(0);
    expect(fs.existsSync(trace)).toBe(false);
    expect(hashTree(root)).toEqual(afterFirst);
    expect(residue(root)).toEqual([]);
  });
});

describe('fix and image bit depth', () => {
  it('refuses to re-encode a 16-bit source but still corrects its extension', async () => {
    const root = copyGitProject('depth');
    const before = hashTree(root);

    const report = await jsonReport(root, ['--allow-renames']);

    const deep = report.results.find((entry) => entry.path === 'assets/deep.png');
    expect(deep?.status).toBe('skipped');
    expect(deep?.reason).toMatch(/16-bit source/);
    expect(hashTree(root).get('assets/deep.png')).toBe(before.get('assets/deep.png'));

    // The rename-only carve-out: the file is moved to the name policy demands,
    // its bytes are untouched, and the width violation it still has is reported
    // as unresolved rather than used as a reason to refuse the rename forever.
    const named = report.results.find((entry) => entry.path === 'assets/deep-named.jpg');
    expect(named?.status).toBe('fixed');
    expect(named?.outputPath).toBe('assets/deep-named.png');
    expect(named?.needsAttention).toBe(true);
    expect(named?.warnings.join(' ')).toMatch(/1600 px wide/);
    expect(hashTree(root).get('assets/deep-named.png')).toBe(before.get('assets/deep-named.jpg'));
    expect(exists(root, 'assets', 'deep-named.jpg')).toBe(false);
  });
});

describe('fix converting a format', () => {
  it('creates the new path, removes the old one, and keeps transparency', async () => {
    const root = copyGitProject('conversion');

    const result = await runCli(['fix', '--allow-renames'], root);
    expect(result.code).toBe(0);

    expect(exists(root, 'assets', 'logo.webp')).toBe(true);
    expect(exists(root, 'assets', 'logo.png')).toBe(false);
    expect(exists(root, 'assets', 'photo.webp')).toBe(true);
    expect(exists(root, 'assets', 'photo.jpg')).toBe(false);

    const logo = await inspect(root, 'assets/logo.webp');
    expect(logo.ok).toBe(true);
    if (!logo.ok) return;
    expect(logo.info.format).toBe('webp');
    expect(logo.info.hasAlpha).toBe(true);
    expect(logo.info.isOpaque).toBe(false);
  });

  it('is idempotent to the letter of 04 section 10', async () => {
    const root = copyGitProject('conversion');

    expect((await runCli(['fix', '--allow-renames'], root)).code).toBe(0);
    const hashes = hashTree(root);
    expect((await runCli(['check'], root)).code).toBe(0);

    const trace = path.join(scratchDir('trace'), 'writes.log');
    const second = await runCli(['fix', '--allow-renames', '--json'], root, {
      RASTERWRIGHT_TRACE_WRITES: trace,
    });
    const report = JSON.parse(second.stdout) as FixReport;

    expect(second.code).toBe(0);
    expect(fs.existsSync(trace)).toBe(false);
    expect(report.results).toEqual([]);
    expect(report.summary.unchanged).toBe(3);
    expect(hashTree(root)).toEqual(hashes);
    expect(residue(root)).toEqual([]);
  });

  it('writes nothing on a second run over the mixed project either', async () => {
    // The weak form, because `mixed` can never reach a clean `check`:
    // `icons/logo.png` carries transparency under a `format: jpeg` rule and is
    // permanently unfixable. `heavy.jpg` is no longer a reason - it is fixed on
    // the first run and left alone on the second.
    const root = copyGitProject('mixed');
    await runCli(['fix', '--allow-renames'], root);
    const hashes = hashTree(root);

    const trace = path.join(scratchDir('trace'), 'writes.log');
    const second = await runCli(['fix', '--allow-renames'], root, { RASTERWRIGHT_TRACE_WRITES: trace });

    expect(second.code).toBe(1);
    expect(fs.existsSync(trace)).toBe(false);
    expect(hashTree(root)).toEqual(hashes);
    expect(residue(root)).toEqual([]);
  });
});

describe('the git precondition', () => {
  it('refuses outside a repository and writes nothing', async () => {
    const root = copyProject('maxheight');
    const files = snapshotTree(root);
    const dirs = snapshotDirs(root);

    const result = await runCli(['fix'], root);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/not inside a git repository/);
    expect(result.stderr).toMatch(/--no-git/);
    expect(result.stderr).toMatch(/--backup-dir/);
    expect(snapshotTree(root)).toEqual(files);
    expect(snapshotDirs(root)).toEqual(dirs);
  });

  it('proceeds with --no-git, saying there is no undo', async () => {
    const root = copyProject('maxheight');
    const result = await runCli(['fix', '--no-git'], root);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/--no-git was given, so these overwrites cannot be undone/);
    const tall = await inspect(root, 'assets/tall.png');
    expect(tall.ok && tall.info.height).toBe(595);
  });

  it('warns about a file with uncommitted changes without refusing it', async () => {
    const root = copyGitProject('maxheight');
    fs.appendFileSync(path.join(root, 'assets', 'tall.png'), Buffer.alloc(4));

    const result = await runCli(['fix'], root);

    expect(result.stderr).toMatch(/assets\/tall\.png has uncommitted changes/);
    expect(result.stderr).toMatch(/commit or stash them first/);
    // A warning and nothing more: the user asked for the fix.
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/1 file fixed/);
  });

  it('names the right remedy for an untracked file', async () => {
    const root = copyGitProject('maxheight', { commit: false });
    const result = await runCli(['fix'], root);

    expect(result.stderr).toMatch(/assets\/tall\.png is not tracked by git/);
    expect(result.stderr).toMatch(/`git add` it or use --backup-dir/);
    expect(result.code).toBe(0);
  });

  it('names the right remedy for a git-ignored file', async () => {
    const root = copyProject('maxheight');
    fs.writeFileSync(path.join(root, '.gitignore'), 'assets/tall.png\n');
    initGitRepo(root);

    // `--no-gitignore` so discovery still sees the file the ignore rule hides.
    const result = await runCli(['fix', '--no-gitignore'], root);

    expect(result.stderr).toMatch(/assets\/tall\.png is excluded by \.gitignore/);
    expect(result.stderr).toMatch(/`git add -f`/);
    expect(result.code).toBe(0);
  });
});

describe('--backup-dir', () => {
  it('mirrors every original it is about to overwrite', async () => {
    const root = copyProject('mixed');
    const backups = path.join(scratchDir('backups'), 'copies');
    const before = hashTree(root);

    const result = await runCli(['fix', '--allow-renames', '--backup-dir', backups], root);
    expect(result.code).toBe(1);

    // One copy per file that was actually written, under its repo-relative path.
    for (const file of [
      'assets/cmyk.jpg',
      'assets/heavy.jpg',
      'assets/oversized.jpg',
      'assets/heroes/hero.jpg',
    ]) {
      expect(fs.existsSync(path.join(backups, file))).toBe(true);
    }
    expect(fs.existsSync(path.join(backups, 'assets/compliant.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(backups, 'assets/icons/logo.png'))).toBe(false);

    // The copies are the originals, byte for byte.
    for (const [file, hash] of hashTree(backups)) {
      expect(before.get(file)).toBe(hash);
    }
  });

  it('satisfies the precondition outside a repository', async () => {
    const root = copyProject('maxheight');
    const backups = path.join(scratchDir('backups'), 'copies');

    const result = await runCli(['fix', '--backup-dir', backups], root);

    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/every original is copied to/);
    expect(fs.existsSync(path.join(backups, 'assets/tall.png'))).toBe(true);
  });

  it('refuses a directory inside the project, before anything is created', async () => {
    const root = copyGitProject('maxheight');
    const files = snapshotTree(root);

    const result = await runCli(['fix', '--backup-dir', 'backups'], root);

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/overlaps the project/);
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
    expect(snapshotTree(root)).toEqual(files);
  });

  it('creates nothing when the run has nothing to write', async () => {
    // A compliant project plans no writes, so there is no original to copy and
    // no reason for a directory to appear.
    const root = copyGitProject('clean');
    const backups = path.join(scratchDir('backups'), 'copies');

    const result = await runCli(['fix', '--backup-dir', backups], root);

    expect(result.code).toBe(0);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('creates nothing when a later precondition refuses the run', async () => {
    const root = copyGitProject('maxheight');
    const backups = path.join(scratchDir('backups'), 'copies');

    // A bad --config fails after --backup-dir has been validated.
    const result = await runCli(['fix', '--backup-dir', backups, '--config', 'nope.yml'], root);

    expect(result.code).toBe(2);
    expect(fs.existsSync(backups)).toBe(false);
  });
});

describe('failures under --json', () => {
  it('still emits a single JSON document on stdout', async () => {
    const root = copyProject('maxheight');
    const result = await runCli(['fix', '--json'], root);

    expect(result.code).toBe(2);
    const document = JSON.parse(result.stdout) as {
      rasterwrightVersion: string;
      error: string;
      exitCode: number;
    };
    expect(document.exitCode).toBe(2);
    expect(document.error).toMatch(/not inside a git repository/);
    expect(document.rasterwrightVersion).toMatch(/^\d+\.\d+\.\d+/);
    // The human message and its hint stay on stderr, so stdout stays parseable.
    expect(result.stderr).toMatch(/--no-git/);
  });

  it('does the same for a check that cannot find its config', async () => {
    const root = copyProject('maxheight');
    const result = await runCli(['check', '--json', '--config', 'nope.yml'], root);

    expect(result.code).toBe(2);
    const document = JSON.parse(result.stdout) as { error: string; exitCode: number };
    expect(document.exitCode).toBe(2);
    expect(document.error).toMatch(/config not found/);
  });

  it('writes nothing to stdout without --json', async () => {
    const root = copyProject('maxheight');
    const result = await runCli(['fix'], root);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
  });
});

describe('command-line validation', () => {
  it('rejects a positional argument rather than ignoring it', async () => {
    const root = copyGitProject('maxheight');
    for (const command of [['check', 'assets/'], ['fix', 'assets/']]) {
      const result = await runCli(command, root);
      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/too many arguments/);
    }
    // And the refusal really did stop before doing anything.
    expect(hashTree(root).get('assets/tall.png')).toBeDefined();
  });

  it('rejects a fractional concurrency instead of rounding it', async () => {
    const root = copyGitProject('maxheight');
    for (const value of ['1.5', '0', '-2', 'four', '']) {
      const result = await runCli(['check', '--concurrency', value], root);
      expect(result.code, `--concurrency ${value}`).toBe(2);
      expect(result.stderr).toMatch(/expected a positive integer/);
    }
  });

  it('still accepts a whole number', async () => {
    const root = copyGitProject('clean');
    expect((await runCli(['check', '--concurrency', '2'], root)).code).toBe(0);
  });
});

describe('crash recovery', () => {
  it('sweeps the temp file a hard kill left behind, then completes', async () => {
    const root = copyGitProject('maxheight');
    const original = hashTree(root).get('assets/tall.png');

    // Aborts between the fsync and the rename, the one moment residue exists.
    await runCli(['fix', '--concurrency', '1'], root, { RASTERWRIGHT_ABORT_AFTER: 'temp-write' });

    const leftovers = residue(root);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatch(/\.rasterwright-tmp-/);
    // The original never moved: the crash happened before the rename.
    expect(hashTree(root).get('assets/tall.png')).toBe(original);

    const rerun = await runCli(['fix'], root);

    expect(rerun.code).toBe(0);
    expect(rerun.stderr).toMatch(/a stale temp file left by an earlier run/);
    expect(residue(root)).toEqual([]);
    const tall = await inspect(root, 'assets/tall.png');
    expect(tall.ok && tall.info.height).toBe(595);
  });
});

describe('interrupting a run', () => {
  it('leaves every file wholly old or wholly new, and no residue', async () => {
    const root = copyGitProject('mixed');
    const before = hashTree(root);
    const trace = path.join(scratchDir('trace'), 'writes.log');

    // One worker and a stall inside the temp write, so the signal is delivered
    // at a deterministic moment rather than a guessed one.
    const { child, done } = spawnCli(['fix', '--allow-renames', '--concurrency', '1'], root, {
      RASTERWRIGHT_TRACE_WRITES: trace,
      RASTERWRIGHT_STALL_MS: '400',
    });

    const deadline = Date.now() + 20_000;
    for (;;) {
      const written = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
      if (written.includes('temp-write')) break;
      if (Date.now() > deadline) throw new Error('the run never reached a temp write');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    child.kill('SIGINT');
    const result = await done;

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/stopping after the files already in flight/);
    expect(result.stdout).toMatch(/Interrupted after \d+ of \d+ files/);
    expect(residue(root)).toEqual([]);

    // Every image is either exactly what it was, or a wholly valid new file.
    // Which of the two the in-flight file lands on is a race; that it is one of
    // them and never anything in between is the property.
    const after = hashTree(root);
    for (const [file, hash] of after) {
      if (!/\.(jpe?g|png|webp)$/.test(file)) continue;
      if (before.get(file) === hash) continue;
      const inspected = await inspect(root, file);
      expect(inspected.ok, `${file} is neither the original nor a valid image`).toBe(true);
    }
  });
});

describe('a file that changes while the run is in flight', () => {
  it('is failed rather than rewritten from a plan describing the old bytes', async () => {
    // `conversion` plans two files. With one worker, the second is provably
    // unread while the first is stalled inside its temp write, so replacing it
    // there is a real edit landing between `check` and the write - not a race
    // the test hopes to win.
    const root = copyGitProject('conversion');
    const victim = path.join(root, 'assets', 'photo.jpg');
    const trace = path.join(scratchDir('trace'), 'writes.log');

    const { child, done } = spawnCli(['fix', '--allow-renames', '--concurrency', '1', '--json'], root, {
      RASTERWRIGHT_TRACE_WRITES: trace,
      RASTERWRIGHT_STALL_MS: '2000',
    });

    const deadline = Date.now() + 20_000;
    for (;;) {
      const written = fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '';
      // The first temp write is `logo.png`'s, which sorts before the victim.
      // A temp file is named for its extension and not for its target, so the
      // trace cannot say which file it belongs to - but with one worker, the
      // victim is provably still ahead of it. If that ever stops holding, the
      // status assertion below fails loudly rather than passing by accident.
      if (written.includes('temp-write')) break;
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error('the run never reached the first temp write');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const substitute = fs.readFileSync(path.join(FIXTURE_IMAGES, 'plain.png'));
    fs.writeFileSync(victim, substitute);

    const result = await done;
    const report = JSON.parse(result.stdout) as FixReport;
    const photo = report.results.find((entry) => entry.path === 'assets/photo.jpg');

    expect(photo?.status).toBe('failed');
    expect(photo?.reason).toMatch(/changed on disk after this run planned it/);
    expect(result.code).toBe(1);

    // The edit survives untouched, and nothing was written under the name the
    // stale plan wanted.
    expect(fs.readFileSync(victim).equals(substitute)).toBe(true);
    expect(exists(root, 'assets', 'photo.webp')).toBe(false);
    // The file that was in flight still completed correctly.
    expect(exists(root, 'assets', 'logo.webp')).toBe(true);
    expect(residue(root)).toEqual([]);
  });
});

describe('fix --json', () => {
  it('puts the report on stdout and every diagnostic on stderr', async () => {
    const root = copyGitProject('mixed');
    const result = await runCli(['fix', '--json', '--allow-renames'], root);

    const report = JSON.parse(result.stdout) as FixReport;
    expect(report.dryRun).toBe(false);
    expect(report.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(report.engine.sharp).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.engine.vips).toMatch(/^\d+\.\d+\.\d+/);
    expect(report.permissions).toEqual({ allowRenames: true });
    expect(report.unrecovered).toEqual([]);

    expect(report.summary.checked).toBe(15);
    expect(report.summary.fixed).toBe(6);
    expect(report.summary.skipped).toBe(1);
    // Warning-only files are counted apart from the genuinely compliant ones,
    // as the plan report counts them, so neither number over-claims.
    expect(report.summary.unchangedWithWarnings).toBe(2);
    expect(report.summary.unchanged).toBe(8);
    expect(report.summary.interrupted).toBe(false);
    expect(report.summary.completed).toBe(15);
    expect(report.summary.bytesAfter).toBeLessThan(report.summary.bytesBefore);

    // Unchanged files are counted and omitted; everything else is listed.
    expect(report.results.every((entry) => entry.status !== 'unchanged')).toBe(true);
    expect(report.results).toHaveLength(7);
    expect(new Set(report.results.map((entry) => entry.status))).toEqual(new Set(['fixed', 'skipped']));

    const fixed = report.results.find((entry) => entry.path === 'assets/heroes/hero.jpg');
    expect(fixed?.outputPath).toBe('assets/heroes/hero.webp');
    expect(fixed?.applied).toEqual(['encode', 'rename']);
    expect(fixed?.after?.format).toBe('webp');
    expect(fixed?.savingsPct).toBeGreaterThan(0);
  });

  it('exits 0 with nothing outstanding', async () => {
    const root = copyGitProject('clean');
    const result = await runCli(['fix', '--json'], root);
    const report = JSON.parse(result.stdout) as FixReport;

    expect(result.code).toBe(0);
    expect(report.results).toEqual([]);
    expect(report.summary.unchanged).toBe(3);
  });
});

describe('fix leaves the git index alone', () => {
  it('stages nothing, even when it rewrites tracked files', async () => {
    const root = copyGitProject('maxheight');
    await runCli(['fix'], root);

    const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' });
    // A leading space in the first column is the point: the file is modified in
    // the work tree and nothing has been staged.
    expect(status).toBe(' M assets/tall.png\n');
  });
});
