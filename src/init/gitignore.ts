import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { isIgnored } from '../operations/git.js';

/**
 * The one file `init` touches that the user did not ask it to create.
 *
 * `fix` never edits a `.gitignore`: an image command that quietly modifies a
 * version-controlled text file would turn up unexplained in the next `git
 * diff`. `init` is the exception, and it is one because generating project
 * configuration is precisely what was asked for, and because `review` will
 * write `.rasterwright/` into the repository whether or not anybody acted on a
 * hint printed six commands ago.
 *
 * The decision is delegated to `git check-ignore` rather than to a string
 * search, so a repository that already covers the directory through a nested
 * `.gitignore`, a negation, `.git/info/exclude` or the user's global excludes
 * is left alone. That also makes a second `init` a no-op for the right reason.
 */

export const GITIGNORE_ENTRY = '.rasterwright/';

const GITIGNORE_COMMENT = "# Rasterwright's working directory (review pages, copies of originals).";

export type GitignoreStatus =
  /** In a work tree, and nothing ignores `.rasterwright/` yet. */
  | 'needed'
  /** Some ignore rule already covers it. */
  | 'already-ignored'
  /** Not a git work tree, or git could not answer. */
  | 'not-a-repo';

export function gitignoreStatus(root: string): GitignoreStatus {
  if (!isInsideWorkTree(root)) return 'not-a-repo';
  const ignored = isIgnored(root, GITIGNORE_ENTRY);
  // `undefined` means git ran and could not say. Treating that as "needed"
  // would edit a file on a guess, so it is treated as "leave it alone".
  return ignored === false ? 'needed' : 'already-ignored';
}

/**
 * Append the entry to `<root>/.gitignore`, creating the file if it is absent.
 *
 * Newline-safe in both directions: an existing file that does not end in a
 * newline gets one before anything is appended, so the last line the user wrote
 * is never merged with the comment, and a blank line separates the block from
 * whatever came before it.
 *
 * The appended lines use whichever ending the file already uses. A `.gitignore`
 * is a text file people read in diffs, and two lines of LF at the bottom of a
 * CRLF file is a whole-file change in some editors and a visible `^M` mismatch
 * in others - a gratuitous edit in a file Rasterwright is already touching more
 * than it would like to.
 */
export function appendGitignoreEntry(root: string): void {
  const target = path.join(root, '.gitignore');

  let existing = '';
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const eol = dominantLineEnding(existing);
  const prefix = existing === '' ? '' : existing.endsWith('\n') ? `${existing}${eol}` : `${existing}${eol}${eol}`;

  fs.writeFileSync(target, `${prefix}${GITIGNORE_COMMENT}${eol}${GITIGNORE_ENTRY}${eol}`, 'utf8');
}

/** CRLF only when the file is mostly CRLF already. LF is the default everywhere. */
function dominantLineEnding(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

function isInsideWorkTree(root: string): boolean {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

  if (result.error !== undefined || result.status !== 0) return false;
  return (result.stdout ?? '').trim() === 'true';
}
