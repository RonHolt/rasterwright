import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { backupOriginal, resolveBackupDir } from '../../src/operations/backup.js';
import { RasterwrightError } from '../../src/utils/errors.js';

const created: string[] = [];

function tempDir(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `rasterwright-${label}-`)));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveBackupDir', () => {
  it('returns an absolute path and creates nothing', () => {
    // Creation is the first copy's job. A run refused after this point, or one
    // that turns out to have nothing to write, must leave no directory behind.
    const parent = tempDir('backup');
    const target = path.join(parent, 'nested', 'copies');
    const resolved = resolveBackupDir(tempDir('project'), target);

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(target);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('creates the whole tree on the first copy', async () => {
    const backupDir = resolveBackupDir(tempDir('project'), path.join(tempDir('backup'), 'nested'));
    await backupOriginal(backupDir, 'assets/a.png', Buffer.from('bytes'));

    expect(fs.readFileSync(path.join(backupDir, 'assets/a.png'), 'utf8')).toBe('bytes');
  });

  it('refuses a path that already exists and is not a directory', () => {
    const parent = tempDir('backup');
    const file = path.join(parent, 'not-a-dir');
    fs.writeFileSync(file, 'x');

    expect(() => resolveBackupDir(tempDir('project'), file)).toThrow(/is not a directory/);
  });

  it('refuses a directory inside the project', () => {
    const root = tempDir('project');
    expect(() => resolveBackupDir(root, path.join(root, 'backups'))).toThrow(RasterwrightError);
    // The refusal happens before anything is created.
    expect(fs.existsSync(path.join(root, 'backups'))).toBe(false);
  });

  it('refuses the project root itself', () => {
    const root = tempDir('project');
    expect(() => resolveBackupDir(root, root)).toThrow(/overlaps the project/);
  });

  it('refuses a directory that contains the project', () => {
    const parent = tempDir('project');
    const root = path.join(parent, 'inner');
    fs.mkdirSync(root);
    expect(() => resolveBackupDir(root, parent)).toThrow(/overlaps the project/);
  });

  it('refuses an empty path', () => {
    expect(() => resolveBackupDir(tempDir('project'), '   ')).toThrow(RasterwrightError);
  });
});

describe('backupOriginal', () => {
  it('mirrors the repo-relative path rather than flattening it', async () => {
    const backupDir = tempDir('backup');
    await backupOriginal(backupDir, 'assets/heroes/logo.png', Buffer.from('one'));
    await backupOriginal(backupDir, 'assets/icons/logo.png', Buffer.from('two'));

    expect(fs.readFileSync(path.join(backupDir, 'assets/heroes/logo.png'), 'utf8')).toBe('one');
    expect(fs.readFileSync(path.join(backupDir, 'assets/icons/logo.png'), 'utf8')).toBe('two');
  });

  it('accepts an existing backup of the same bytes, so a rerun works', async () => {
    const backupDir = tempDir('backup');
    await backupOriginal(backupDir, 'a.png', Buffer.from('same'));
    await expect(backupOriginal(backupDir, 'a.png', Buffer.from('same'))).resolves.toBeDefined();
    expect(fs.readFileSync(path.join(backupDir, 'a.png'), 'utf8')).toBe('same');
  });

  it('refuses to overwrite a backup holding different bytes', async () => {
    // The existing copy may be the only surviving original; replacing it with a
    // copy of an intermediate state is the one thing this directory exists to
    // make impossible.
    const backupDir = tempDir('backup');
    await backupOriginal(backupDir, 'a.png', Buffer.from('original'));

    await expect(backupOriginal(backupDir, 'a.png', Buffer.from('changed'))).rejects.toThrow(
      /already holds a different backup/,
    );
    expect(fs.readFileSync(path.join(backupDir, 'a.png'), 'utf8')).toBe('original');
  });
});
