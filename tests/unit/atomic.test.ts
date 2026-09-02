import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MOVING_INFIX,
  TEMP_PREFIX,
  TempRegistry,
  commitRename,
  convertAndReplace,
  needsTwoStepRename,
  recoverInterruptedMoves,
  sweepStaleTemps,
  tempNameFor,
  writeCandidate,
} from '../../src/operations/atomic.js';
import { REPO_ROOT } from '../helpers/project.js';

const execFileAsync = promisify(execFile);

/**
 * Every test here runs against a real temp directory, because the properties
 * being asserted are properties of the filesystem: a mode that survived, an
 * mtime that moved, a temp file that is not there any more. A mocked `fs` would
 * only prove that the mock was called.
 */
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rasterwright-atomic-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.RASTERWRIGHT_TRACE_WRITES;
});

function at(name: string): string {
  return path.join(dir, name);
}

function write(name: string, contents: string, mode = 0o644): string {
  const absolute = at(name);
  fs.writeFileSync(absolute, contents);
  fs.chmodSync(absolute, mode);
  return absolute;
}

/** Names left in the directory that Rasterwright would recognise as its own residue. */
function temps(directory = dir): string[] {
  return fs.readdirSync(directory).filter((entry) => entry.startsWith(TEMP_PREFIX));
}

describe('tempNameFor', () => {
  it('puts the temp file beside its target, so the rename cannot cross devices', () => {
    const temp = tempNameFor(at('assets/hero.jpg'));
    expect(path.dirname(temp)).toBe(path.dirname(at('assets/hero.jpg')));
  });

  it('keeps the extension and marks the file as Rasterwright residue', () => {
    const temp = path.basename(tempNameFor(at('hero.jpg')));
    expect(temp.startsWith(TEMP_PREFIX)).toBe(true);
    expect(temp.endsWith('.jpg')).toBe(true);
    expect(temp).toContain(String(process.pid));
  });

  it('never collides with itself', () => {
    const names = new Set(Array.from({ length: 200 }, () => tempNameFor(at('hero.jpg'))));
    expect(names.size).toBe(200);
  });
});

describe('writeCandidate', () => {
  it('replaces the target contents', async () => {
    const target = write('hero.jpg', 'old');
    await writeCandidate(target, Buffer.from('new bytes'), { mode: 0o644 });
    expect(fs.readFileSync(target, 'utf8')).toBe('new bytes');
  });

  it('preserves the mode it was given, regardless of the process umask', async () => {
    const target = write('hero.jpg', 'old', 0o640);
    await writeCandidate(target, Buffer.from('new'), { mode: 0o640 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  });

  it('preserves an unusual mode too', async () => {
    const target = write('hero.jpg', 'old', 0o755);
    await writeCandidate(target, Buffer.from('new'), { mode: 0o755 });
    expect(fs.statSync(target).mode & 0o777).toBe(0o755);
  });

  it('moves the mtime forward, because a changed file should look changed', async () => {
    const target = write('hero.jpg', 'old');
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(target, past, past);
    const before = fs.statSync(target).mtimeMs;

    await writeCandidate(target, Buffer.from('new'), { mode: 0o644 });
    expect(fs.statSync(target).mtimeMs).toBeGreaterThan(before);
  });

  it('creates a target that did not exist', async () => {
    const target = at('fresh.webp');
    await writeCandidate(target, Buffer.from('bytes'), { mode: 0o644 });
    expect(fs.readFileSync(target, 'utf8')).toBe('bytes');
  });

  it('leaves no temp file behind on success', async () => {
    await writeCandidate(write('hero.jpg', 'old'), Buffer.from('new'), { mode: 0o644 });
    expect(temps()).toEqual([]);
  });

  it('leaves no temp file behind when the rename fails', async () => {
    // A directory cannot be replaced by a rename, so this fails after the temp
    // file exists and has been fsynced: exactly the window residue comes from.
    const target = at('occupied');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'child'), 'x');

    await expect(writeCandidate(target, Buffer.from('new'), { mode: 0o644 })).rejects.toThrow();
    expect(temps()).toEqual([]);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it('leaves the registry empty after a success and after a failure', async () => {
    const registry = new TempRegistry();
    await writeCandidate(write('hero.jpg', 'old'), Buffer.from('new'), { mode: 0o644, registry });
    expect(registry.paths()).toEqual([]);

    fs.mkdirSync(at('occupied'));
    fs.writeFileSync(at('occupied/child'), 'x');
    await expect(
      writeCandidate(at('occupied'), Buffer.from('new'), { mode: 0o644, registry }),
    ).rejects.toThrow();
    expect(registry.paths()).toEqual([]);
  });
});

describe('convertAndReplace', () => {
  it('writes the new path and removes the old one', async () => {
    const source = write('logo.png', 'png bytes');
    const target = at('logo.webp');

    await convertAndReplace(source, target, Buffer.from('webp bytes'), 0o644);

    expect(fs.readFileSync(target, 'utf8')).toBe('webp bytes');
    expect(fs.existsSync(source)).toBe(false);
    expect(temps()).toEqual([]);
  });

  it('creates the new file before it removes the old one', async () => {
    // The ordering is the whole safety property: a crash between the two steps
    // must leave both files rather than neither.
    const trace = at('trace.log');
    process.env.RASTERWRIGHT_TRACE_WRITES = trace;

    const source = write('logo.png', 'png bytes');
    await convertAndReplace(source, at('logo.webp'), Buffer.from('webp bytes'), 0o644);

    const steps = fs
      .readFileSync(trace, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' ')[0]);
    expect(steps).toEqual(['temp-write', 'rename', 'unlink']);
  });

  it('refuses to be used for an in-place rewrite', async () => {
    const target = write('logo.png', 'bytes');
    await expect(convertAndReplace(target, target, Buffer.from('new'), 0o644)).rejects.toThrow(
      /one path/,
    );
    expect(fs.readFileSync(target, 'utf8')).toBe('bytes');
  });

  it('says both files are on disk when the source cannot be removed', async () => {
    const source = at('logo.png');
    await expect(
      convertAndReplace(source, at('logo.webp'), Buffer.from('webp bytes'), 0o644),
    ).rejects.toThrow(/are now on disk/);
    // The new file was written first, which is why the failure is reported this
    // way rather than as "nothing happened".
    expect(fs.readFileSync(at('logo.webp'), 'utf8')).toBe('webp bytes');
  });
});

describe('commitRename', () => {
  it('renames without touching the bytes', async () => {
    const source = write('logo.png', 'webp bytes really');
    const intermediate = await commitRename(source, at('logo.webp'));

    expect(intermediate).toBeUndefined();
    expect(fs.readFileSync(at('logo.webp'), 'utf8')).toBe('webp bytes really');
    expect(fs.existsSync(source)).toBe(false);
  });

  it('refuses to rename onto a path that already holds something', async () => {
    write('logo.webp', 'a real image that is not ours to destroy');
    const source = write('logo.png', 'webp bytes really');

    await expect(commitRename(source, at('logo.webp'))).rejects.toThrow(/already exists there/);
    expect(fs.readFileSync(at('logo.webp'), 'utf8')).toBe('a real image that is not ours to destroy');
    expect(fs.existsSync(source)).toBe(true);
  });

  it('refuses even when the occupant is a directory or a dangling symlink', async () => {
    fs.mkdirSync(at('a.webp'));
    await expect(commitRename(write('a.png', 'x'), at('a.webp'))).rejects.toThrow(/already exists/);

    fs.symlinkSync(at('nowhere-at-all'), at('b.webp'));
    await expect(commitRename(write('b.png', 'x'), at('b.webp'))).rejects.toThrow(/already exists/);
  });

  it('takes the two-step route only where the filesystem folds case', () => {
    expect(needsTwoStepRename('/a/photo.JPG', '/a/photo.jpg', 'case-insensitive')).toBe(true);
    expect(needsTwoStepRename('/a/Photo.jpg', '/a/photo.jpg', 'case-insensitive')).toBe(true);
    expect(needsTwoStepRename('/a/photo.png', '/a/photo.webp', 'case-insensitive')).toBe(false);
    expect(needsTwoStepRename('/a/photo.jpg', '/a/photo.jpg', 'case-insensitive')).toBe(false);

    // On a case-sensitive filesystem the direct rename works, so putting the
    // user's only copy under an interim name would be risk taken for nothing.
    expect(needsTwoStepRename('/a/photo.JPG', '/a/photo.jpg', 'case-sensitive')).toBe(false);
  });

  it('renames directly on a case-sensitive filesystem', async () => {
    const source = write('photo.JPG', 'jpeg bytes');
    const intermediate = await commitRename(source, at('photo.jpg'), { semantics: 'case-sensitive' });

    expect(intermediate).toBeUndefined();
    expect(fs.readFileSync(at('photo.jpg'), 'utf8')).toBe('jpeg bytes');
  });

  it('goes through an intermediate name where case is folded', async () => {
    // A direct rename of `a.JPG` to `a.jpg` is a no-op on macOS and Windows,
    // where the two names are one file, so the extension would never actually
    // be corrected. Going through a third name forces the rename to happen.
    const source = write('photo.JPG', 'jpeg bytes');
    const intermediate = await commitRename(source, at('photo.jpg'), {
      semantics: 'case-insensitive',
    });

    expect(intermediate).toBeDefined();
    expect(fs.readFileSync(at('photo.jpg'), 'utf8')).toBe('jpeg bytes');
    expect(fs.readdirSync(dir)).toEqual(['photo.jpg']);
  });

  it('names the interim file after where it was going, and not as residue', async () => {
    // For the moment it exists this file is the user's only copy, so it must
    // not look like anything a cleanup pass is allowed to delete.
    const intermediate =
      (await commitRename(write('photo.JPG', 'bytes'), at('photo.jpg'), {
        semantics: 'case-insensitive',
      })) ?? '';

    expect(path.basename(intermediate).startsWith(TEMP_PREFIX)).toBe(false);
    expect(path.basename(intermediate)).toMatch(/^photo\.jpg\.rasterwright-moving-\d+-[0-9a-f]+$/);
  });
});

/**
 * The window in a case-only rename where the image exists under neither its old
 * name nor its new one. Everything about this window is about not losing the
 * file, because during it there is no second copy anywhere.
 */
describe('an interrupted case-only rename', () => {
  async function interrupt(): Promise<string> {
    const script = at('move.mjs');
    fs.writeFileSync(
      script,
      `import { commitRename } from ${JSON.stringify(
        path.join(REPO_ROOT, 'src', 'operations', 'atomic.ts'),
      )};\n` +
        `await commitRename(${JSON.stringify(at('photo.JPG'))}, ${JSON.stringify(
          at('photo.jpg'),
        )}, { semantics: 'case-insensitive' });\n`,
    );

    write('photo.JPG', 'the only copy of this image');
    try {
      await execFileAsync(process.execPath, ['--import', 'tsx', script], {
        cwd: REPO_ROOT,
        env: { ...process.env, RASTERWRIGHT_ABORT_AFTER: 'first-rename' },
      });
      throw new Error('expected the child process to abort');
    } catch (error) {
      if ((error as Error).message === 'expected the child process to abort') throw error;
    }

    const moving = fs.readdirSync(dir).filter((entry) => entry.includes(MOVING_INFIX));
    expect(moving).toHaveLength(1);
    return moving[0] as string;
  }

  it('leaves the image on disk under its interim name', async () => {
    const moving = await interrupt();
    expect(fs.readFileSync(at(moving), 'utf8')).toBe('the only copy of this image');
  });

  it('is not swept away as stale residue', async () => {
    const moving = await interrupt();
    expect(await sweepStaleTemps([dir])).toEqual([]);
    expect(fs.existsSync(at(moving))).toBe(true);
  });

  it('cannot even be registered for interrupt cleanup', async () => {
    const moving = await interrupt();
    const registry = new TempRegistry();

    expect(() => registry.add(at(moving))).toThrow(/only .* are disposable/);
    expect(registry.cleanup()).toEqual([]);
    expect(fs.existsSync(at(moving))).toBe(true);
  });

  it('is put back under its intended name by the next run', async () => {
    await interrupt();
    const recovery = await recoverInterruptedMoves([dir], 'case-insensitive');

    expect(recovery.recovered).toEqual([at('photo.jpg')]);
    expect(recovery.needsAttention).toEqual([]);
    expect(fs.readFileSync(at('photo.jpg'), 'utf8')).toBe('the only copy of this image');
    expect(fs.readdirSync(dir).filter((entry) => entry.includes(MOVING_INFIX))).toEqual([]);
  });
});

describe('recoverInterruptedMoves', () => {
  it('leaves an interim file alone when its intended name is taken', async () => {
    // Deleting it would be the only way to "clean up", and it is an image.
    fs.writeFileSync(at('photo.jpg'), 'something else entirely');
    const moving = at(`photo.jpg${MOVING_INFIX}${process.pid}-abcdef`);
    fs.writeFileSync(moving, 'the interrupted one');

    const recovery = await recoverInterruptedMoves([dir], 'case-insensitive');

    expect(recovery.recovered).toEqual([]);
    expect(recovery.needsAttention).toEqual([moving]);
    expect(fs.readFileSync(moving, 'utf8')).toBe('the interrupted one');
    expect(fs.readFileSync(at('photo.jpg'), 'utf8')).toBe('something else entirely');
  });

  it('folds case when deciding whether the intended name is taken', async () => {
    fs.writeFileSync(at('Photo.JPG'), 'the same file under another spelling');
    const moving = at(`photo.jpg${MOVING_INFIX}${process.pid}-abcdef`);
    fs.writeFileSync(moving, 'the interrupted one');

    expect((await recoverInterruptedMoves([dir], 'case-insensitive')).needsAttention).toEqual([moving]);
    expect((await recoverInterruptedMoves([dir], 'case-sensitive')).recovered).toEqual([at('photo.jpg')]);
  });

  it('recovers only the first of two interim files claiming one name', async () => {
    const first = at(`photo.jpg${MOVING_INFIX}${process.pid}-aaaaaa`);
    const second = at(`photo.jpg${MOVING_INFIX}${process.pid}-bbbbbb`);
    fs.writeFileSync(first, 'one');
    fs.writeFileSync(second, 'two');

    const recovery = await recoverInterruptedMoves([dir], 'case-insensitive');

    expect(recovery.recovered).toEqual([at('photo.jpg')]);
    expect(recovery.needsAttention).toEqual([second]);
    expect(fs.existsSync(second)).toBe(true);
  });

  it('ignores ordinary files and never deletes anything', async () => {
    fs.writeFileSync(at('hero.jpg'), 'an image');
    fs.writeFileSync(at(`${TEMP_PREFIX}9-abc.jpg`), 'residue');

    const recovery = await recoverInterruptedMoves([dir], 'case-insensitive');

    expect(recovery).toEqual({ recovered: [], needsAttention: [] });
    expect(fs.readdirSync(dir).sort()).toEqual([`${TEMP_PREFIX}9-abc.jpg`, 'hero.jpg']);
  });
});

describe('TempRegistry', () => {
  it('unlinks everything it is holding', () => {
    const registry = new TempRegistry();
    const first = at(`${TEMP_PREFIX}1.jpg`);
    const second = at(`${TEMP_PREFIX}2.jpg`);
    fs.writeFileSync(first, 'a');
    fs.writeFileSync(second, 'b');
    registry.add(first);
    registry.add(second);

    expect(registry.cleanup().sort()).toEqual([first, second].sort());
    expect(temps()).toEqual([]);
    expect(registry.paths()).toEqual([]);
  });

  it('forgets a path that was renamed away', () => {
    const registry = new TempRegistry();
    const temp = at(`${TEMP_PREFIX}1.jpg`);
    fs.writeFileSync(temp, 'a');
    registry.add(temp);
    registry.remove(temp);

    expect(registry.cleanup()).toEqual([]);
    expect(fs.existsSync(temp)).toBe(true);
  });

  it('never throws on a file that is already gone', () => {
    const registry = new TempRegistry();
    registry.add(at(`${TEMP_PREFIX}missing.jpg`));
    expect(() => registry.cleanup()).not.toThrow();
  });
});

describe('sweepStaleTemps', () => {
  it('removes only Rasterwright residue', async () => {
    fs.writeFileSync(at(`${TEMP_PREFIX}abc.jpg`), 'residue');
    fs.writeFileSync(at('hero.jpg'), 'a real image');
    fs.writeFileSync(at('.hidden'), 'not ours');
    fs.writeFileSync(at('rasterwright-tmp-nodot.jpg'), 'not ours either');

    const removed = await sweepStaleTemps([dir]);

    expect(removed).toEqual([at(`${TEMP_PREFIX}abc.jpg`)]);
    expect(fs.readdirSync(dir).sort()).toEqual(['.hidden', 'hero.jpg', 'rasterwright-tmp-nodot.jpg']);
  });

  it('sweeps several directories and reports what it removed', async () => {
    fs.mkdirSync(at('a'));
    fs.mkdirSync(at('b'));
    fs.writeFileSync(at(`a/${TEMP_PREFIX}1.jpg`), 'x');
    fs.writeFileSync(at(`b/${TEMP_PREFIX}2.png`), 'y');
    fs.writeFileSync(at('b/keep.png'), 'z');

    const removed = await sweepStaleTemps([at('a'), at('b'), at('a')]);

    expect(removed).toEqual([at(`a/${TEMP_PREFIX}1.jpg`), at(`b/${TEMP_PREFIX}2.png`)]);
    expect(fs.readdirSync(at('b'))).toEqual(['keep.png']);
  });

  it('returns nothing and throws nothing for a directory it cannot read', async () => {
    await expect(sweepStaleTemps([at('nowhere')])).resolves.toEqual([]);
  });

  it('leaves a temp file whose owning process is still running', async () => {
    // Another Rasterwright run is using it right now. Deleting it would turn
    // that run's safe write into a failed one.
    const live = at(`${TEMP_PREFIX}${process.pid}-abcdef.jpg`);
    const dead = at(`${TEMP_PREFIX}999999999-abcdef.jpg`);
    fs.writeFileSync(live, 'in flight');
    fs.writeFileSync(dead, 'residue');

    expect(await sweepStaleTemps([dir])).toEqual([dead]);
    expect(fs.readFileSync(live, 'utf8')).toBe('in flight');
  });

  it('never touches a file left behind by an interrupted rename', async () => {
    const moving = at(`${TEMP_PREFIX}9-a.jpg${MOVING_INFIX}999999999-abcdef`);
    fs.writeFileSync(moving, 'an image, not residue');

    expect(await sweepStaleTemps([dir])).toEqual([]);
    expect(fs.existsSync(moving)).toBe(true);
  });
});

describe('failures say which file they are about', () => {
  it('names the target when the bytes cannot be staged', async () => {
    await expect(
      writeCandidate(at('missing-dir/hero.jpg'), Buffer.from('x'), { mode: 0o644 }),
    ).rejects.toThrow(/could not stage the new bytes for .*missing-dir\/hero\.jpg/);
  });

  it('names the target when the rename fails', async () => {
    fs.mkdirSync(at('occupied'));
    fs.writeFileSync(at('occupied/child'), 'x');

    await expect(writeCandidate(at('occupied'), Buffer.from('x'), { mode: 0o644 })).rejects.toThrow(
      /could not put the new bytes in place at .*occupied/,
    );
  });

  it('names both paths when a converted source cannot be removed', async () => {
    await expect(
      convertAndReplace(at('logo.png'), at('logo.webp'), Buffer.from('x'), 0o644),
    ).rejects.toThrow(/both .*logo\.png and .*logo\.webp are now on disk/);
  });

  it('refuses to convert onto a path that already exists', async () => {
    write('logo.webp', 'not ours to destroy');
    const source = write('logo.png', 'png bytes');

    await expect(
      convertAndReplace(source, at('logo.webp'), Buffer.from('x'), 0o644),
    ).rejects.toThrow(/refusing to write .*logo\.webp/);
    expect(fs.readFileSync(at('logo.webp'), 'utf8')).toBe('not ours to destroy');
    expect(fs.readFileSync(source, 'utf8')).toBe('png bytes');
    expect(temps()).toEqual([]);
  });
});

describe('test-only hooks', () => {
  it('writes nothing anywhere when the trace variable is unset', async () => {
    delete process.env.RASTERWRIGHT_TRACE_WRITES;
    await writeCandidate(write('hero.jpg', 'old'), Buffer.from('new'), { mode: 0o644 });
    expect(fs.readdirSync(dir)).toEqual(['hero.jpg']);
  });

  it('records one line per mutating step when it is set', async () => {
    const trace = at('trace.log');
    process.env.RASTERWRIGHT_TRACE_WRITES = trace;

    await writeCandidate(write('hero.jpg', 'old'), Buffer.from('new'), { mode: 0o644 });

    const lines = fs.readFileSync(trace, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`^temp-write .*${TEMP_PREFIX.replace('.', '\\.')}`));
    expect(lines[1]).toMatch(/^rename .* -> .*hero\.jpg$/);
  });

  it('leaves the original intact when the process is killed between fsync and rename', async () => {
    // The one moment residue is possible, exercised for real: a child process
    // aborts right after the fsync, and the assertion is that the original file
    // is untouched and the only thing left over is a sweepable temp file.
    const target = write('hero.jpg', 'original bytes');
    const script = at('abort.mjs');
    fs.writeFileSync(
      script,
      `import { writeCandidate } from ${JSON.stringify(
        path.join(REPO_ROOT, 'src', 'operations', 'atomic.ts'),
      )};\n` +
        `await writeCandidate(${JSON.stringify(target)}, Buffer.from('replacement'), { mode: 0o644 });\n`,
    );

    let aborted = false;
    try {
      await execFileAsync(process.execPath, ['--import', 'tsx', script], {
        cwd: REPO_ROOT,
        env: { ...process.env, RASTERWRIGHT_ABORT_AFTER: 'temp-write' },
      });
    } catch {
      aborted = true;
    }

    expect(aborted).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('original bytes');
    expect(temps()).toHaveLength(1);

    // And a later run cleans it up, which is the point of the sweep.
    expect(await sweepStaleTemps([dir])).toHaveLength(1);
    expect(temps()).toEqual([]);
  });
});
