import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
export const FIXTURE_PROJECTS = path.join(REPO_ROOT, 'fixtures', 'projects');
export const FIXTURE_IMAGES = path.join(REPO_ROOT, 'fixtures', 'images');

const tempDirs: string[] = [];

/**
 * Copy a fixture project into a fresh temp directory.
 *
 * Tests always run against a copy, never against the checked-in fixture, so a
 * bug that writes to disk cannot corrupt the repository.
 */
export function copyProject(name: string): string {
  const source = path.join(FIXTURE_PROJECTS, name);
  if (!fs.existsSync(source)) throw new Error(`no such fixture project: ${name}`);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `rasterwright-${name}-`));
  fs.cpSync(source, target, { recursive: true });
  tempDirs.push(target);
  return target;
}

export function cleanupProjects(): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Absolute URL of tsx's loader.
 *
 * The CLI is spawned with the *project* as its working directory, which is
 * outside this repository, so `--import tsx` would not resolve. The absolute
 * URL sidesteps module resolution entirely.
 */
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

/** Run the real CLI as a child process, so exit codes and stream separation are exercised. */
export async function runCli(args: string[], cwd: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', TSX_LOADER, CLI_ENTRY, ...args],
      { cwd, maxBuffer: 32 * 1024 * 1024 },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}
