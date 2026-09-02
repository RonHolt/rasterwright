import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { classifyPath, surveyGit } from '../../src/operations/git.js';

/**
 * Real repositories, real `git` invocations. The whole value of this module is
 * that it agrees with git about what git knows, and a stubbed git would only
 * prove that the stub agrees with itself.
 *
 * Each test repository is created fresh in a temp directory with its identity
 * configured locally, so nothing depends on the machine's global git config.
 */
let dir: string;
const originalPath = process.env.PATH;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rasterwright-git-'));
});

afterEach(() => {
  process.env.PATH = originalPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
}

function initRepo(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'fixtures@rasterwright.test');
  git(root, 'config', 'user.name', 'Rasterwright Fixtures');
}

function put(root: string, relative: string, contents: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

describe('repository detection', () => {
  it('finds the work tree root', () => {
    initRepo(dir);
    const survey = surveyGit(dir, []);

    expect(survey.state).toBe('in-repo');
    expect(fs.realpathSync(survey.toplevel ?? '')).toBe(fs.realpathSync(dir));
    expect(survey.reason).toBeUndefined();
  });

  it('finds it from a subdirectory, which is where a config usually lives', () => {
    initRepo(dir);
    const project = path.join(dir, 'packages', 'theme');
    fs.mkdirSync(project, { recursive: true });

    const survey = surveyGit(project, []);
    expect(survey.state).toBe('in-repo');
    expect(fs.realpathSync(survey.toplevel ?? '')).toBe(fs.realpathSync(dir));
  });

  it('reports a directory outside any repository as such', () => {
    // A bare temp directory is not inside a work tree, which is exactly the
    // case where `fix` has no undo and must refuse without --no-git.
    const survey = surveyGit(dir, []);
    expect(survey.state).toBe('not-a-repo');
    expect(survey.toplevel).toBeUndefined();
    expect(survey.reason).toMatch(/not a git repository/i);
  });

  it('does not call a root it could not enter "not a repository"', () => {
    // `fix` refuses to run outside a repository and proceeds inside one, so a
    // confident wrong answer here sends the whole run down the wrong path. Git
    // failing to change directory is not evidence about repositories at all.
    const survey = surveyGit(path.join(dir, 'does', 'not', 'exist'), []);

    expect(survey.state).toBe('unknown');
    expect(survey.reason).toMatch(/cannot change to|No such file/i);
  });
});

describe('classifying the files a run would overwrite', () => {
  beforeEach(() => {
    initRepo(dir);
    put(dir, 'assets/clean.png', 'clean');
    put(dir, 'assets/dirty.png', 'original');
    put(dir, 'assets/staged.png', 'original');
    git(dir, 'add', 'assets/clean.png', 'assets/dirty.png', 'assets/staged.png');
    git(dir, 'commit', '--quiet', '-m', 'initial');

    put(dir, 'assets/dirty.png', 'edited in the work tree');
    put(dir, 'assets/staged.png', 'edited and staged');
    git(dir, 'add', 'assets/staged.png');
    put(dir, 'assets/new.png', 'never seen by git');
  });

  const paths = [
    'assets/clean.png',
    'assets/dirty.png',
    'assets/staged.png',
    'assets/new.png',
  ];

  it('separates modified, staged and untracked from clean', () => {
    const survey = surveyGit(dir, paths);

    expect(survey.state).toBe('in-repo');
    expect(survey.modified).toEqual(['assets/dirty.png', 'assets/staged.png']);
    expect(survey.untracked).toEqual(['assets/new.png']);
  });

  it('treats a staged change as a change, because it is still uncommitted', () => {
    expect(classifyPath(surveyGit(dir, paths), 'assets/staged.png')).toBe('modified');
  });

  it('classifies each path the caller asked about', () => {
    const survey = surveyGit(dir, paths);
    expect(paths.map((file) => classifyPath(survey, file))).toEqual([
      'clean',
      'modified',
      'modified',
      'untracked',
    ]);
  });

  it('ignores files outside the paths it was asked about', () => {
    put(dir, 'assets/elsewhere.png', 'also untracked');
    const survey = surveyGit(dir, ['assets/new.png']);

    expect(survey.untracked).toEqual(['assets/new.png']);
  });

  it('names an untracked file individually rather than collapsing its directory', () => {
    put(dir, 'fresh/deep/one.png', 'a');
    put(dir, 'fresh/deep/two.png', 'b');

    const survey = surveyGit(dir, ['fresh/deep/one.png', 'fresh/deep/two.png']);
    expect(survey.untracked).toEqual(['fresh/deep/one.png', 'fresh/deep/two.png']);
  });

  it('returns paths relative to the project root, not to the work tree root', () => {
    // `git status --porcelain` reports paths from the top of the repository,
    // while the pathspecs it accepts are relative to the working directory.
    // A config living below the repo root would otherwise never match.
    const project = path.join(dir, 'site');
    put(dir, 'site/assets/inner.png', 'untracked');

    const survey = surveyGit(project, ['assets/inner.png']);
    expect(survey.untracked).toEqual(['assets/inner.png']);
  });

  it('handles more paths than fit in one invocation', () => {
    const many: string[] = [];
    for (let index = 0; index < 2500; index += 1) {
      const relative = `bulk/file-${index}.png`;
      put(dir, relative, String(index));
      many.push(relative);
    }

    const survey = surveyGit(dir, many);
    expect(survey.untracked).toHaveLength(2500);
  });

  it('says nothing about a repository with nothing to report', () => {
    const survey = surveyGit(dir, ['assets/clean.png']);
    expect(survey.modified).toEqual([]);
    expect(survey.untracked).toEqual([]);
  });

  it('asks git nothing when there are no paths', () => {
    const survey = surveyGit(dir, []);
    expect(survey).toMatchObject({ state: 'in-repo', modified: [], untracked: [], ignored: [] });
  });

  it('reports an ignored file rather than passing over it as clean', () => {
    // Git has no history for an ignored file either, so overwriting it is as
    // irreversible as overwriting an untracked one.
    put(dir, '.gitignore', 'assets/generated.png\n');
    put(dir, 'assets/generated.png', 'built, not committed');

    const survey = surveyGit(dir, ['assets/generated.png', 'assets/clean.png']);

    expect(survey.ignored).toEqual(['assets/generated.png']);
    expect(survey.untracked).toEqual([]);
    expect(classifyPath(survey, 'assets/generated.png')).toBe('ignored');
    expect(classifyPath(survey, 'assets/clean.png')).toBe('clean');
  });

  it('asks about a filename containing glob characters as itself', () => {
    // Without --literal-pathspecs git reads `[1]` as a character class, matches
    // nothing, and the file the run is about to overwrite reads as clean.
    put(dir, 'assets/star[1].png', 'untracked');

    expect(surveyGit(dir, ['assets/star[1].png']).untracked).toEqual(['assets/star[1].png']);
  });

  it('refuses to answer about a path that escapes the project root', () => {
    // Git would report it relative to the work tree root, where it cannot be
    // matched back to what the caller asked. Dropping the line would report the
    // file as clean, and it is anything but.
    const project = path.join(dir, 'site');
    fs.mkdirSync(project, { recursive: true });
    put(dir, 'outside.png', 'untracked');

    const survey = surveyGit(project, ['../outside.png']);

    expect(survey.state).toBe('unknown');
    expect(survey.reason).toMatch(/outside/);
  });
});

describe('graceful degradation', () => {
  it('reports unknown, never clean, when git cannot be run at all', () => {
    initRepo(dir);
    process.env.PATH = '';

    const survey = surveyGit(dir, ['assets/clean.png']);
    expect(survey.state).toBe('unknown');
    expect(survey.reason).toMatch(/git could not be run/);
    expect(survey.modified).toEqual([]);
  });

  it('classifies every path as unknown once the survey failed', () => {
    process.env.PATH = '';
    expect(classifyPath(surveyGit(dir, ['a.png']), 'a.png')).toBe('unknown');
  });

  it('does not mistake a git that answers nothing for a clean tree', () => {
    // A git on PATH that succeeds and prints nothing looks exactly like a repo
    // with no changes, except that it never told us where the work tree is.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const fake = path.join(bin, 'git');
    fs.writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fake, 0o755);
    process.env.PATH = bin;

    const survey = surveyGit(dir, ['a.png']);
    expect(survey.state).toBe('unknown');
    expect(survey.reason).toMatch(/no work tree root/);
  });

  it('reports a git that refuses as not a repository, which is a real answer', () => {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const fake = path.join(bin, 'git');
    fs.writeFileSync(fake, '#!/bin/sh\necho "fatal: not a git repository" >&2\nexit 128\n');
    fs.chmodSync(fake, 0o755);
    process.env.PATH = bin;

    expect(surveyGit(dir, ['a.png']).state).toBe('not-a-repo');
  });
});

describe('the survey writes nothing', () => {
  it('leaves the repository exactly as it found it', () => {
    initRepo(dir);
    put(dir, 'assets/a.png', 'a');
    git(dir, 'add', 'assets/a.png');
    git(dir, 'commit', '--quiet', '-m', 'initial');
    put(dir, 'assets/a.png', 'edited');

    const before = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    surveyGit(dir, ['assets/a.png']);
    const after = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });

    expect(after).toBe(before);
  });
});
