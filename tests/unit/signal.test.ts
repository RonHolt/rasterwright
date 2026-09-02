import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TempRegistry } from '../../src/operations/atomic.js';
import { createStopFlag, installStopHandlers } from '../../src/utils/signal.js';

const uninstallers: (() => void)[] = [];

afterEach(() => {
  for (const uninstall of uninstallers.splice(0)) uninstall();
  vi.restoreAllMocks();
});

function install(registry = new TempRegistry()) {
  const flag = createStopFlag();
  const written: string[] = [];
  const uninstall = installStopHandlers(flag, registry, (text) => written.push(text));
  uninstallers.push(uninstall);
  return { flag, written, uninstall, registry };
}

describe('installStopHandlers', () => {
  it('sets the flag on the first signal and cleans up nothing', () => {
    const registry = new TempRegistry();
    const temp = path.join(os.tmpdir(), `.rasterwright-tmp-${process.pid}-signal.png`);
    fs.writeFileSync(temp, 'in flight');
    registry.add(temp);

    const { flag, written } = install(registry);
    process.emit('SIGINT', 'SIGINT');

    expect(flag.requested).toBe(true);
    expect(flag.signal).toBe('SIGINT');
    expect(written.join('')).toMatch(/stopping after the files already in flight/);
    // Deliberately still there: a worker can be between open and rename, and
    // unlinking its temp file would turn a safe write into a failed one.
    expect(fs.existsSync(temp)).toBe(true);

    fs.unlinkSync(temp);
  });

  it('cleans up and exits on the second signal', () => {
    const registry = new TempRegistry();
    const temp = path.join(os.tmpdir(), `.rasterwright-tmp-${process.pid}-second.png`);
    fs.writeFileSync(temp, 'in flight');
    registry.add(temp);

    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    install(registry);

    process.emit('SIGINT', 'SIGINT');
    process.emit('SIGINT', 'SIGINT');

    expect(exit).toHaveBeenCalledWith(1);
    expect(fs.existsSync(temp)).toBe(false);
  });

  it('removes both listeners when uninstalled', () => {
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const { uninstall, flag } = install();

    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);

    uninstall();

    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(flag.requested).toBe(false);
  });

  it('responds to SIGTERM as well as SIGINT', () => {
    const { flag } = install();
    process.emit('SIGTERM', 'SIGTERM');
    expect(flag.signal).toBe('SIGTERM');
  });
});
