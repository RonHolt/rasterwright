import { spawn } from 'node:child_process';

/**
 * Opening the page in whatever the platform considers a browser.
 *
 * Deliberately the smallest thing that works. 04 section 12 defers Windows
 * handling beyond what Node provides, and an opener is not worth a dependency:
 * three platforms, three commands, no shell.
 *
 * ## Never through a shell
 *
 * The path is passed as an argument, never interpolated into a command string.
 * A project directory can contain a space, an ampersand, a quote or a `$`, and
 * every one of those is a different kind of wrong answer once a shell sees it.
 * `start` is a `cmd` builtin, so Windows needs `cmd /c start ""` - the empty
 * string is the window title, and without it `start` reads the first quoted
 * argument as the title and opens nothing.
 */

export interface Opener {
  command: string;
  /** Arguments that come before the path. */
  args: string[];
}

export function openerFor(platform: NodeJS.Platform): Opener {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  return { command: 'xdg-open', args: [] };
}

/**
 * Open `absolutePath`, and never let that failure become the command's failure.
 *
 * Detached with stdio ignored, and unreferenced, so the opener outlives this
 * process and the process does not wait for a browser to exit. The page has
 * already been written by the time this is called: not being able to open it is
 * a fact about the desktop session, not about the run, and the caller reports it
 * as a diagnostic beside the path the user can open by hand.
 *
 * Returns a message when the opener could not be started, and `undefined`
 * otherwise. "Started" is all that can be known: a headless machine's
 * `xdg-open` can exit non-zero seconds later, and waiting for that would trade a
 * useful command for a slow one.
 */
export function openInBrowser(
  absolutePath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const opener = openerFor(platform);
  try {
    const child = spawn(opener.command, [...opener.args, absolutePath], {
      detached: true,
      stdio: 'ignore',
    });
    // A spawn failure surfaces asynchronously on the child, long after this
    // function has returned, so it is swallowed here rather than crashing the
    // process from an unhandled 'error' event.
    child.on('error', () => undefined);
    child.unref();
    return undefined;
  } catch (error) {
    return `could not run ${opener.command}: ${error instanceof Error ? error.message : String(error)}`;
  }
}
