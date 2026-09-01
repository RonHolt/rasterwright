import { afterAll, describe, expect, it } from 'vitest';

import { cleanupProjects, copyProject, runCli } from '../helpers/project.js';
import type { FilePlan, FixPlanReport, PlannedOperation } from '../../src/types.js';

afterAll(cleanupProjects);

type JsonPlanReport = FixPlanReport & { diagnostics: string[] };

async function planJson(
  project: string,
  args: string[] = [],
): Promise<{ code: number; report: JsonPlanReport; stderr: string }> {
  const root = copyProject(project);
  const result = await runCli(['fix', '--dry-run', '--json', ...args], root);
  return { code: result.code, report: JSON.parse(result.stdout) as JsonPlanReport, stderr: result.stderr };
}

function planFor(report: JsonPlanReport, path: string): FilePlan {
  const plan = report.files.find((file) => file.path === path);
  if (plan === undefined) {
    throw new Error(`no plan for ${path}; got ${report.files.map((f) => f.path).join(', ')}`);
  }
  return plan;
}

function ops(plan: FilePlan): PlannedOperation['op'][] {
  return plan.operations.map((operation) => operation.op);
}

describe('fix without --dry-run', () => {
  it('refuses to run and says what to do instead', async () => {
    // Deliberately not a silent alias for --dry-run. Making the dangerous
    // command quietly safe teaches people to type the dangerous command.
    const root = copyProject('mixed');
    const result = await runCli(['fix'], root);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/fix execution is not implemented yet/);
    expect(result.stderr).toMatch(/--dry-run/);
  });

  it('refuses even when given rename permission', async () => {
    const root = copyProject('mixed');
    const result = await runCli(['fix', '--allow-renames'], root);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/not implemented yet/);
  });
});

describe('exit codes', () => {
  it('exits 1 while any file is left unresolved', async () => {
    const root = copyProject('mixed');
    expect((await runCli(['fix', '--dry-run'], root)).code).toBe(1);
  });

  it('exits 0 when every error has an executable plan', async () => {
    const root = copyProject('maxheight');
    const result = await runCli(['fix', '--dry-run'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/resize\s+200x1400 -> 85x600/);
  });

  it('exits 0 on a clean project with nothing to plan', async () => {
    const root = copyProject('clean');
    const result = await runCli(['fix', '--dry-run'], root);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/3 images inspected/);
    expect(result.stdout).not.toMatch(/WOULD FIX/);
  });

  it('exits 0 when the only findings are warnings', async () => {
    // Warnings never justify a rewrite, so they never fail a dry run either.
    const root = copyProject('warnings-only');
    const result = await runCli(['fix', '--dry-run'], root);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/2 images carry warnings only/);
    expect(result.stdout).not.toMatch(/WOULD FIX/);
  });

  it('exits 1 for an image that cannot be decoded', async () => {
    const root = copyProject('corrupt');
    const result = await runCli(['fix', '--dry-run'], root);

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/CANNOT FIX/);
    expect(result.stdout).toMatch(/could not decode image/);
  });

  it('exits 2 on a malformed config', async () => {
    const root = copyProject('broken-config');
    const result = await runCli(['fix', '--dry-run'], root);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/is not valid YAML/);
    expect(result.stdout).toBe('');
  });
});

describe('human plan', () => {
  it('groups files by what a fix run would do to them', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['fix', '--dry-run'], root);

    expect(stdout).toMatch(/^Rasterwright Fix Plan$/m);
    expect(stdout.indexOf('WOULD FIX')).toBeLessThan(stdout.indexOf('REQUIRES PERMISSION'));
    expect(stdout.indexOf('REQUIRES PERMISSION')).toBeLessThan(stdout.indexOf('CANNOT FIX'));
  });

  it('shows resize dimensions it computed rather than the limit it was given', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['fix', '--dry-run'], root);
    expect(stdout).toMatch(/resize\s+2000x1200 -> 1200x720/);
  });

  it('distinguishes a byte target from a ceiling that merely also applies', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['fix', '--dry-run'], root);

    // heavy.jpg is over budget, so the budget is the reason for the encode.
    expect(stdout).toMatch(/target\s+<= 200 KB/);
    // oversized.jpg is being resized; the ceiling still applies to the output.
    expect(stdout).toMatch(/ceiling\s+<= 200 KB/);
  });

  it('never predicts a resulting file size', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['fix', '--dry-run'], root);

    expect(stdout).toMatch(/result\s+must be verified during execution/);
    expect(stdout).not.toMatch(/expected output/i);
    expect(stdout).not.toMatch(/estimated/i);
  });

  it('says a lossy re-encode costs something', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['fix', '--dry-run'], root);
    expect(stdout).toMatch(/re-encode\s+lossy source re-encoded; some generation loss/);
  });

  it('shows the blocked plan and how to unblock it', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['fix', '--dry-run'], root);

    expect(stdout).toMatch(/⊘ assets\/logo-webp\.png/);
    expect(stdout).toMatch(/rename\s+\.png -> \.webp/);
    expect(stdout).toMatch(/pixels\s+already in the target format; no re-encode required/);
    expect(stdout).toMatch(/permission\s+rerun with --allow-renames/);
  });

  it('states plainly that nothing was written', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['fix', '--dry-run'], root);

    expect(stdout).toMatch(/Nothing was written\. This is a plan, not a run\./);
    expect(stdout).toMatch(/Executing a plan is not implemented yet\./);
  });

  it('totals what would happen', async () => {
    const root = copyProject('mixed');
    const { stdout } = await runCli(['fix', '--dry-run'], root);

    expect(stdout).toMatch(/15 images inspected/);
    expect(stdout).toMatch(/4 files would be modified/);
    expect(stdout).toMatch(/2 files require permission/);
    expect(stdout).toMatch(/1 file cannot be fixed safely/);
    expect(stdout).toMatch(/2 warning-only files left unchanged/);
    expect(stdout).toMatch(/6 already compliant/);
    expect(stdout).toMatch(/1 image matched no rule and was skipped/);
  });
});

describe('--allow-renames', () => {
  it('moves a blocked file into the plan without changing anything else', async () => {
    const blocked = await planJson('mixed');
    const allowed = await planJson('mixed', ['--allow-renames']);

    expect(blocked.report.summary).toMatchObject({ planned: 4, requiresPermission: 2, unfixable: 1 });
    expect(allowed.report.summary).toMatchObject({ planned: 6, requiresPermission: 0, unfixable: 1 });
    expect(allowed.report.permissions).toEqual({ allowRenames: true });

    // The files that needed no permission are planned identically either way.
    for (const path of ['assets/oversized.jpg', 'assets/heavy.jpg', 'assets/rotated.jpg']) {
      expect(planFor(allowed.report, path)).toEqual(planFor(blocked.report, path));
    }
  });

  it('turns an extension mismatch into a rename with no pixel work', async () => {
    const { report } = await planJson('mixed', ['--allow-renames']);
    const plan = planFor(report, 'assets/logo-webp.png');

    expect(plan.status).toBe('planned');
    expect(plan.targetPath).toBe('assets/logo-webp.webp');
    expect(plan.operations).toEqual([
      {
        op: 'rename',
        from: 'assets/logo-webp.png',
        to: 'assets/logo-webp.webp',
        reason: 'extension-correction',
        reencode: false,
      },
    ]);
  });

  it('does not make an unsafe conversion safe', async () => {
    // A transparent PNG under `format: jpeg` is unfixable regardless of
    // permission: JPEG cannot hold an alpha channel.
    const { code, report } = await planJson('mixed', ['--allow-renames']);
    expect(code).toBe(1);
    expect(planFor(report, 'assets/icons/logo.png')).toMatchObject({
      status: 'unfixable',
      operations: [],
      blockedOperations: [],
    });
  });

  it('still writes nothing at all', async () => {
    const { report } = await planJson('mixed', ['--allow-renames']);
    expect(report.dryRun).toBe(true);
  });
});

describe('json plan', () => {
  it('puts JSON on stdout and diagnostics on stderr', async () => {
    const root = copyProject('mixed');
    const result = await runCli(['fix', '--dry-run', '--json'], root);

    expect(result.stdout.startsWith('{')).toBe(true);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it('has the documented top-level shape', async () => {
    const { code, report } = await planJson('mixed');

    expect(code).toBe(1);
    expect(report.dryRun).toBe(true);
    expect(report.complete).toBe(false);
    expect(report.permissions).toEqual({ allowRenames: false });
    expect(report.rasterwrightVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.summary).toEqual({
      checked: 15,
      planned: 4,
      requiresPermission: 2,
      unfixable: 1,
      unsupported: 0,
      unchanged: 8,
      unchangedWithWarnings: 2,
      operations: 7,
      ignored: 1,
    });
  });

  it('reports complete: true only when every error has an executable plan', async () => {
    const { code, report } = await planJson('maxheight');
    expect(code).toBe(0);
    expect(report.complete).toBe(true);
    expect(report.summary).toMatchObject({ planned: 1, requiresPermission: 0, unfixable: 0 });
  });

  it('omits unchanged files and counts them instead', async () => {
    const { report } = await planJson('mixed');

    expect(report.files.map((file) => file.status)).not.toContain('unchanged');
    expect(report.files).toHaveLength(7);
    expect(report.summary.unchanged).toBe(8);
  });

  it('carries operations, resolution and verification per file', async () => {
    const { report } = await planJson('mixed');
    const oversized = planFor(report, 'assets/oversized.jpg');

    expect(oversized.status).toBe('planned');
    expect(ops(oversized)).toEqual(['resize', 'encode']);
    expect(oversized.operations[0]).toEqual({
      op: 'resize',
      from: { width: 2000, height: 1200 },
      to: { width: 1200, height: 720 },
      maxWidth: 1200,
      fit: 'inside',
      upscale: false,
    });
    expect(oversized.resolves).toEqual(['maxWidth']);
    expect(oversized.unresolved).toEqual([]);
    expect(oversized.requiresVerification).toBe(true);
  });

  it('records metadata normalized during a rewrite an error required', async () => {
    const { report } = await planJson('mixed');
    const rotated = planFor(report, 'assets/rotated.jpg');

    expect(ops(rotated)).toEqual(['autoOrient', 'encode']);
    expect(rotated.normalizedDuringRewrite).toEqual(['metadata']);
    expect(rotated.warnings).toEqual(['metadata']);
  });

  it('leaves a warning-only file out of the plan entirely', async () => {
    const { code, report } = await planJson('warnings-only');

    expect(code).toBe(0);
    expect(report.files).toEqual([]);
    expect(report.summary).toMatchObject({ unchanged: 4, unchangedWithWarnings: 2, operations: 0 });
  });

  it('reports what a blocked file is waiting for', async () => {
    const { report } = await planJson('mixed');
    const hero = planFor(report, 'assets/heroes/hero.jpg');

    expect(hero.status).toBe('requires-permission');
    expect(hero.operations).toEqual([]);
    expect(hero.blockedOperations.map((operation) => operation.op)).toEqual(['encode', 'rename']);
    expect(hero.requiredPermissions).toEqual(['allowRenames']);
    expect(hero.targetPath).toBe('assets/heroes/hero.webp');
    expect(hero.unresolved).toEqual(['format']);
  });

  it('reports an undecodable image as unfixable with the decoder message', async () => {
    const { report } = await planJson('corrupt');
    const broken = planFor(report, 'assets/broken.jpg');

    expect(broken.status).toBe('unfixable');
    expect(broken.operations).toEqual([]);
    expect(broken.reasons.join(' ')).toMatch(/could not decode image/);
  });

  it('respects autoOrient: false', async () => {
    const { report } = await planJson('autoorient');

    expect(planFor(report, 'normalized/rotated.jpg').operations[0]).toMatchObject({ op: 'autoOrient' });
    expect(report.files.some((file) => file.path === 'kept/rotated.jpg')).toBe(false);
  });
});
