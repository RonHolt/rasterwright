import { afterAll, describe, expect, it } from 'vitest';

import { cleanupProjects, copyProject, runCliWithClosedStdout } from '../helpers/project.js';

afterAll(cleanupProjects);

/**
 * A reader that stops reading is not an error.
 *
 * `rasterwright check --json | head -60` is how anyone looks at a long report,
 * and `head` closes the pipe the moment it has its sixty lines. Before this was
 * handled, the write that followed raised `EPIPE` as an unhandled `'error'`
 * event on `process.stdout`: Node printed its own stack trace across the
 * terminal and exited 1, so a routine command looked like a crash and a script
 * gating on the exit code could not tell the difference.
 *
 * What these assert is the absence of noise. The exit code is allowed to be
 * whatever the command computed - a fixture with errors still exits 1 - as long
 * as nothing about the broken pipe reaches stderr and the process is not killed.
 */
describe('a closed stdout reader', () => {
  /** Node's crash output, and the shape of anything else that leaked. */
  function expectQuiet(stderr: string): void {
    expect(stderr).not.toContain('EPIPE');
    expect(stderr).not.toContain('Unhandled');
    expect(stderr).not.toMatch(/^\s+at /m);
  }

  for (const when of ['immediately', 'after-first-chunk'] as const) {
    it(`leaves check --json quiet when the reader closes ${when}`, async () => {
      const root = copyProject('mixed');
      const result = await runCliWithClosedStdout(['check', '--json'], root, when);

      expectQuiet(result.stderr);
      // 0 or 1 - a real result. Anything else means the process died.
      expect([0, 1]).toContain(result.code);
    });

    it(`leaves the human check quiet when the reader closes ${when}`, async () => {
      const root = copyProject('mixed');
      const result = await runCliWithClosedStdout(['check'], root, when);

      expectQuiet(result.stderr);
      expect([0, 1]).toContain(result.code);
    });
  }

  /**
   * The failure path writes to both streams, and with `--json` it writes a
   * document to the stdout that has just gone away. It has to stay quiet too.
   */
  it('leaves a failing run quiet when the reader closes immediately', async () => {
    const root = copyProject('broken-config');
    const result = await runCliWithClosedStdout(['check', '--json'], root, 'immediately');

    expectQuiet(result.stderr);
    expect(result.code).toBe(2);
  });
});
