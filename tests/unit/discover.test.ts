import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { discover } from '../../src/scanner/discover.js';

const dirs: string[] = [];

function project(files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rasterwright-discover-')));
  dirs.push(dir);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('discover', () => {
  it('finds supported extensions and ignores everything else', () => {
    const root = project({
      'assets/a.jpg': '',
      'assets/b.jpeg': '',
      'assets/c.png': '',
      'assets/d.webp': '',
      'assets/e.gif': '',
      'assets/f.svg': '',
      'assets/notes.txt': '',
    });
    expect(discover(root).files).toEqual(['assets/a.jpg', 'assets/b.jpeg', 'assets/c.png', 'assets/d.webp']);
  });

  it('matches extensions case-insensitively', () => {
    const root = project({ 'assets/HERO.JPG': '', 'assets/Logo.PNG': '' });
    expect(discover(root).files.sort()).toEqual(['assets/HERO.JPG', 'assets/Logo.PNG']);
  });

  it('always skips node_modules, .git and .rasterwright', () => {
    const root = project({
      'assets/keep.png': '',
      'node_modules/pkg/logo.png': '',
      '.git/objects/thing.png': '',
      '.rasterwright/review/before/x.png': '',
    });
    expect(discover(root).files).toEqual(['assets/keep.png']);
  });

  it('skips hidden directories', () => {
    const root = project({ 'assets/keep.png': '', '.cache/hidden.png': '' });
    expect(discover(root).files).toEqual(['assets/keep.png']);
  });

  it('returns repo-relative POSIX paths, sorted', () => {
    const root = project({ 'b/two.png': '', 'a/one.png': '' });
    expect(discover(root).files).toEqual(['a/one.png', 'b/two.png']);
  });

  it('respects .gitignore inside a git work tree', () => {
    const root = project({
      '.gitignore': 'assets/generated/\n*.tmp.png\n',
      'assets/keep.png': '',
      'assets/generated/skip.png': '',
      'assets/thing.tmp.png': '',
    });
    execFileSync('git', ['init', '-q'], { cwd: root });

    const result = discover(root);
    expect(result.gitignoreApplied).toBe(true);
    expect(result.files).toEqual(['assets/keep.png']);
  });

  it('can be told to ignore .gitignore', () => {
    const root = project({ '.gitignore': 'assets/generated/\n', 'assets/generated/skip.png': '' });
    execFileSync('git', ['init', '-q'], { cwd: root });

    const result = discover(root, { noGitignore: true });
    expect(result.gitignoreApplied).toBe(false);
    expect(result.files).toEqual(['assets/generated/skip.png']);
  });

  it('reports, rather than hides, that gitignore could not be applied outside a repo', () => {
    const root = project({ '.gitignore': 'assets/\n', 'assets/keep.png': '' });
    const result = discover(root);
    expect(result.gitignoreApplied).toBe(false);
    expect(result.gitignoreSkippedReason).toMatch(/not a git work tree/);
    // Failing open is deliberate: a git-ignored file is checked rather than skipped.
    expect(result.files).toEqual(['assets/keep.png']);
  });
});
