import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  // Physical path, because the CLI reports physical paths: its `process.cwd()`
  // has symlinks resolved, and on macOS `os.tmpdir()` is one (`/var` is a link
  // to `/private/var`). Every temp directory in the suite is resolved the same
  // way so that a path a test builds is the path the CLI prints.
  const target = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `rasterwright-${name}-`)));
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
export async function runCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', TSX_LOADER, CLI_ENTRY, ...args],
      { cwd, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/**
 * The same CLI, but with a handle on the process.
 *
 * `runCli` resolves only once the child has exited, which is no use for a test
 * that has to deliver a signal while the run is in flight.
 */
export function spawnCli(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): { child: ChildProcess; done: Promise<CliResult> } {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, ...env },
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  const done = new Promise<CliResult>((resolve) => {
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

  return { child, done };
}

/**
 * Make `root` a git repository, so `fix` runs without `--no-git`.
 *
 * `copyProject` copies into the system temp directory, which is outside any
 * repository, so nearly every fix test needs this first.
 *
 * The global and system git configs are pointed at `/dev/null` and identity is
 * passed per invocation, so a developer's commit template, hooks or signing
 * configuration cannot make a test pass on their machine and fail in CI.
 */
export function initGitRepo(root: string, options: { commit?: boolean } = {}): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], {
      env,
      stdio: 'ignore',
    });
  };

  git('init', '-q', '-b', 'main');
  // A commit can spawn `git maintenance run --auto` in the background, which
  // takes and drops `.git/objects/maintenance.lock` while a test is still
  // snapshotting the tree - a file that is there for `readdir` and gone for
  // `stat`. Nothing in the suite wants a repository maintained.
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  if (options.commit === false) return;
  git('add', '-A');
  git('commit', '-qm', 'fixtures', '--no-gpg-sign');
}

/** A fixture project, copied to a temp directory and made into a git repository. */
export function copyGitProject(name: string, options: { commit?: boolean } = {}): string {
  const root = copyProject(name);
  initGitRepo(root, options);
  return root;
}

/**
 * Every file under `root`, repo-relative POSIX, with its content hash. Sorted.
 *
 * `.git` and `.rasterwright` are skipped. The review directory holds a run id
 * and a timestamp that differ on every run, so including it would make every
 * "two runs produce the same tree" assertion fail for a reason that has nothing
 * to do with images. The review output has its own assertions instead; point
 * this function straight at `<root>/.rasterwright` to hash it.
 */
export function hashTree(root: string): Map<string, string> {
  const hashes = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.rasterwright') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      hashes.set(
        path.relative(root, absolute).split(path.sep).join('/'),
        createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
      );
    }
  };
  walk(root);
  return new Map([...hashes].sort(([a], [b]) => a.localeCompare(b)));
}

/** Every leftover Rasterwright interim file under `root`. Must always be empty after a run. */
export function residue(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.rasterwright') continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.name.startsWith('.rasterwright-tmp-') || entry.name.includes('.rasterwright-moving-')) {
        found.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Run the CLI against a reader that closes stdout before the CLI is done with it.
 *
 * This is `rasterwright check --json | head -60`, or a `less` the user quit out
 * of: the read end of the pipe goes away and the next write fails with `EPIPE`.
 * Node reports that as an `'error'` event on `process.stdout`, so without a
 * handler it is an unhandled error - a stack trace printed over the terminal for
 * something the user did on purpose.
 *
 * `when` picks which of the two shapes to exercise. `'immediately'` closes the
 * pipe before the CLI writes anything, which fails every write and is the only
 * one that reproduces reliably regardless of how much a fixture prints.
 * `'after-first-chunk'` is closer to what `head` actually does, but output small
 * enough to fit in the pipe buffer is already accepted by the kernel before the
 * reader goes, so it may well succeed - it is here to prove that case is quiet
 * too, not to force the failure.
 */
export function runCliWithClosedStdout(
  args: string[],
  cwd: string,
  when: 'immediately' | 'after-first-chunk',
  env: NodeJS.ProcessEnv = {},
): Promise<CliResult> {
  const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));

  if (when === 'immediately') {
    child.stdout?.destroy();
  } else {
    child.stdout?.once('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      child.stdout?.destroy();
    });
  }

  return new Promise<CliResult>((resolve) => {
    child.on('close', (code, signal) => {
      resolve({ code: signal === null ? (code ?? 1) : -1, stdout, stderr });
    });
  });
}
