import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * What git knows about the files a fix run is about to overwrite. Read-only.
 *
 * 04 section 8 makes git the undo mechanism: `fix` overwrites tracked files in
 * place and relies on `git checkout --` rather than keeping a parallel set of
 * backups. That only holds where git actually has the previous bytes, so before
 * writing anything the run asks two questions.
 *
 *   1. Is this a repository at all? Outside one there is no undo, and `fix`
 *      refuses unless the user passes `--no-git` or `--backup-dir`.
 *   2. Which of these files have changes git has not stored? Those are the one
 *      thing an overwrite could destroy irrecoverably, so they are warned about
 *      per file. A warning, never a block: the user asked for the fix.
 *
 * Untracked files are warned about separately from modified ones, because the
 * remedies differ. A modified file is recovered with `git checkout` or `git
 * stash`; an untracked one has no history at all and needs `git add` or
 * `--backup-dir` before it is safe to touch.
 *
 * This module produces data and nothing else. Deciding what to refuse and what
 * to warn about belongs to the executor.
 */

export type GitState =
  /** `root` is inside a git work tree and the survey succeeded. */
  | 'in-repo'
  /** git ran and said this is not a work tree. */
  | 'not-a-repo'
  /**
   * git could not answer. Never treated as clean: an unknown answer about
   * whether an overwrite is recoverable is not a reassuring one.
   */
  | 'unknown';

/** How a single path stands relative to what git has stored. */
export type GitPathState = 'clean' | 'modified' | 'untracked' | 'ignored' | 'unknown';

export interface GitSurvey {
  state: GitState;
  /** Absolute path to the work tree root. Undefined unless `state` is `in-repo`. */
  toplevel: string | undefined;
  /** What git said, when it said something useful about a failure or refusal. */
  reason: string | undefined;
  /**
   * Tracked paths with uncommitted changes, staged or not, repo-relative POSIX
   * as they were passed in. Sorted.
   */
  modified: string[];
  /** Paths git has no history for at all, in the same form. Sorted. */
  untracked: string[];
  /**
   * Paths a `.gitignore` rule excludes. Sorted.
   *
   * Git has no history for these either, so callers treat them like untracked
   * files rather than like clean ones. They are reported separately because the
   * remedy differs: an ignored image needs `git add -f` or `--backup-dir`, and
   * telling the user to `git add` a file their own ignore rules exclude would
   * be advice that does not work.
   */
  ignored: string[];
}

/**
 * Pathspecs per `git status` invocation.
 *
 * A single argument list has a hard size limit (`E2BIG`), and a project with
 * thousands of images would hit it. A thousand paths per call keeps every
 * invocation far below any platform's limit while costing a handful of
 * processes on the largest realistic run.
 */
const PATHSPEC_CHUNK = 1000;

/**
 * Ask git about `paths`, which are repo-relative POSIX paths under `root`.
 *
 * `root` may sit below the work tree root, which is why detection asks
 * `rev-parse --show-toplevel` rather than looking for a `.git` directory beside
 * the config.
 */
export function surveyGit(root: string, paths: readonly string[]): GitSurvey {
  const empty = { modified: [] as string[], untracked: [] as string[], ignored: [] as string[] };

  const toplevel = detectToplevel(root);
  if (toplevel.state !== 'in-repo') {
    return { state: toplevel.state, toplevel: undefined, reason: toplevel.reason, ...empty };
  }

  if (paths.length === 0) {
    return { state: 'in-repo', toplevel: toplevel.path, reason: undefined, ...empty };
  }

  // `git status --porcelain` prints paths relative to the work tree root, while
  // the pathspecs it takes are relative to the working directory. Those are the
  // same thing only when the config sits at the top of the repo, so the prefix
  // has to come back off to give the caller the paths it asked about.
  //
  // Both sides have to be physical paths. `--show-toplevel` comes back with
  // symlinks resolved, and a `root` reached through one (macOS's `/var` is a
  // link to `/private/var`, for a start) would otherwise sit "outside" its own
  // work tree and turn every answer into `unknown`.
  const prefix = toPosixPrefix(toplevel.path, physicalPath(root));

  const modified = new Set<string>();
  const untracked = new Set<string>();
  const ignored = new Set<string>();

  const unknown = (reason: string): GitSurvey => ({
    state: 'unknown',
    toplevel: toplevel.path,
    reason,
    modified: [],
    untracked: [],
    ignored: [],
  });

  for (let index = 0; index < paths.length; index += PATHSPEC_CHUNK) {
    const chunk = paths.slice(index, index + PATHSPEC_CHUNK);
    const result = git(root, [
      'status',
      '--porcelain',
      '-z',
      '--no-renames',
      // Without this an untracked file inside an untracked directory is reported
      // as the directory, and the file the run is about to overwrite is never
      // named.
      '--untracked-files=all',
      // Ignored files are reported rather than passed over in silence. Git has
      // no history for one, so overwriting it is as irreversible as overwriting
      // an untracked file, and reading it as "clean" would be exactly wrong.
      // `matching` names the files themselves rather than their directories.
      '--ignored=matching',
      '--',
      ...chunk,
    ]);

    if (result.failure !== undefined) return unknown(result.failure);

    for (const entry of result.stdout.split('\0')) {
      // `XY <path>`: index status, work tree status, space, path. With
      // `--no-renames` there is never a second NUL-separated field to skip.
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const reported = entry.slice(3);
      const relative = stripPrefix(reported, prefix);
      if (relative === undefined) {
        // Git named a path outside the directory the caller asked about, which
        // means the caller passed a pathspec that escapes it. Dropping the line
        // would report the file as clean, and it is anything but.
        return unknown(
          `git reported ${reported}, which is outside ${root}; ` +
            'Rasterwright cannot tell which requested path that answers',
        );
      }

      if (code === '!!') ignored.add(relative);
      else if (code === '??') untracked.add(relative);
      else modified.add(relative);
    }
  }

  return {
    state: 'in-repo',
    toplevel: toplevel.path,
    reason: undefined,
    modified: [...modified].sort(),
    untracked: [...untracked].sort(),
    ignored: [...ignored].sort(),
  };
}

/**
 * Where one path stands.
 *
 * A path the survey did not name is clean, but only when the survey actually
 * happened. Outside a repo, or after a failure, the honest answer is `unknown`.
 */
export function classifyPath(survey: GitSurvey, relativePath: string): GitPathState {
  if (survey.state !== 'in-repo') return 'unknown';

  const lookup = indexOf(survey);
  if (lookup.ignored.has(relativePath)) return 'ignored';
  if (lookup.untracked.has(relativePath)) return 'untracked';
  if (lookup.modified.has(relativePath)) return 'modified';
  return 'clean';
}

interface GitIndex {
  modified: ReadonlySet<string>;
  untracked: ReadonlySet<string>;
  ignored: ReadonlySet<string>;
}

/**
 * Set views over a survey's arrays, built once per survey.
 *
 * The arrays stay the public shape because a report wants them ordered, but a
 * run asks this question once per governed file, and a linear scan per file
 * would be quadratic on the projects most worth being careful about.
 */
const indexes = new WeakMap<GitSurvey, GitIndex>();

function indexOf(survey: GitSurvey): GitIndex {
  const cached = indexes.get(survey);
  if (cached !== undefined) return cached;

  const built: GitIndex = {
    modified: new Set(survey.modified),
    untracked: new Set(survey.untracked),
    ignored: new Set(survey.ignored),
  };
  indexes.set(survey, built);
  return built;
}

type ToplevelResult =
  | { state: 'in-repo'; path: string; reason: undefined }
  | { state: 'not-a-repo' | 'unknown'; path: undefined; reason: string | undefined };

/** The one refusal that is an answer rather than a failure to get one. */
const NOT_A_REPOSITORY = /not a git repository/i;

function detectToplevel(root: string): ToplevelResult {
  const result = git(root, ['rev-parse', '--show-toplevel']);

  if (result.failure !== undefined) {
    // A spawn failure means git is not installed or not on PATH. Not knowing
    // whether an overwrite is recoverable is different from knowing it is not.
    if (result.spawnFailed) return { state: 'unknown', path: undefined, reason: result.failure };
    // git ran and refused, but only one refusal means "there is no repository
    // here". Everything else - an unreadable directory, a root that does not
    // exist, a broken `.git` - is a question git could not answer, and reading
    // any of them as a confident "not a repo" would send the run down the
    // "there is no undo, refuse unless --no-git" path for the wrong reason.
    if (NOT_A_REPOSITORY.test(result.failure)) {
      return { state: 'not-a-repo', path: undefined, reason: result.failure };
    }
    return { state: 'unknown', path: undefined, reason: result.failure };
  }

  const toplevel = result.stdout.trim();
  if (toplevel === '') {
    return { state: 'unknown', path: undefined, reason: 'git reported no work tree root' };
  }
  return { state: 'in-repo', path: physicalPath(toplevel), reason: undefined };
}

/** `target` with symlinks resolved, or merely made absolute when it cannot be read. */
function physicalPath(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Whether git ignores `relativePath`, or `undefined` when it could not say.
 *
 * `check-ignore -q` answers in its exit status: `0` ignored, `1` not ignored,
 * anything else a failure - outside a repository, git missing, an unreadable
 * `.gitignore`. Those all come back as `undefined` rather than as `false`,
 * because "git has no opinion" and "git says no" lead callers to different
 * places, and only one of them is a fact.
 *
 * Read-only. Nothing about `check-ignore` touches the index or the work tree.
 */
export function isIgnored(root: string, relativePath: string): boolean | undefined {
  // No `--literal-pathspecs` here, unlike everywhere else in this module:
  // `check-ignore` rejects pathspec magic outright and exits 128. The only
  // caller passes a fixed literal with no glob characters in it, so nothing is
  // lost - but a caller that ever passes a real filename must quote it itself.
  const result = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--', relativePath], {
    encoding: 'buffer',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

  if (result.error !== undefined) return undefined;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return undefined;
}

interface GitResult {
  stdout: string;
  /** A description of what went wrong, or undefined on success. */
  failure: string | undefined;
  /** True when git could not be run at all, as opposed to running and refusing. */
  spawnFailed: boolean;
}

/**
 * Run git, the same way `scanner/discover.ts` does.
 *
 * `GIT_OPTIONAL_LOCKS=0` matters more here than it does during `check`: a fix
 * run is writing to the work tree, and git refreshing the index underneath it
 * would be both a lock contention risk and a write Rasterwright did not make.
 *
 * `--literal-pathspecs` turns off git's own glob and magic-prefix syntax, so a
 * filename containing `*`, `?`, `[`, or a leading `:` is asked about as itself.
 * Without it an image called `star[1].png` would silently match nothing, and a
 * file the run is about to overwrite would be reported as clean.
 */
function git(root: string, args: readonly string[]): GitResult {
  const result = spawnSync('git', ['-C', root, '--literal-pathspecs', ...args], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

  if (result.error !== undefined) {
    return { stdout: '', failure: `git could not be run: ${result.error.message}`, spawnFailed: true };
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.toString('utf8').trim() ?? '';
    return {
      stdout: '',
      failure: stderr === '' ? `git exited ${result.status}` : stderr.split('\n')[0],
      spawnFailed: false,
    };
  }

  return { stdout: result.stdout?.toString('utf8') ?? '', failure: undefined, spawnFailed: false };
}

/** `root` as a POSIX path relative to the work tree root, with a trailing slash. */
function toPosixPrefix(toplevel: string, root: string): string {
  const relative = path.relative(toplevel, path.resolve(root)).split(path.sep).join('/');
  return relative === '' ? '' : `${relative}/`;
}

/** Strip the work tree prefix, or undefined for a path outside `root` entirely. */
function stripPrefix(reported: string, prefix: string): string | undefined {
  if (prefix === '') return reported;
  return reported.startsWith(prefix) ? reported.slice(prefix.length) : undefined;
}
