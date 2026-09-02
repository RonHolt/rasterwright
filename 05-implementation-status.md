# Rasterwright Implementation Status

**Purpose:** durable current-state record for future sessions. Read this
right after `CLAUDE.md`. It is rewritten at the end of each phase, not
appended to. Product scope lives in `03`, architecture in `04`, user-facing
behaviour in `README.md`; this file only records where the implementation is.

## Current state

- HEAD: `3c3076e feat: add safe fix execution foundation`, plus uncommitted
  work wiring the executor (phase 2b).
- Implemented commands: `check` (`--verbose`, `--json`), `fix --dry-run`
  (`--json`, `--allow-renames`), and `fix` (`--allow-renames`, `--json`,
  `--no-git`, `--backup-dir`, `--concurrency`).
- Not implemented: byte-budget execution, `review`, `init`.
- Baseline: 566 tests across 19 files, `npm run typecheck` clean,
  `npm run build` clean.
- Sharp pinned exactly at `0.35.4`.

## Completed phases

| Phase | Commit |
|---|---|
| Read-only `check` | `a8b3332` |
| Severity + real-world check refinements | `b3b312b`, `75dbc63` |
| Read-only `fix --dry-run` (pure planner) | `2860c4e` |
| Batch plan preflight (`blocked` status, collisions fixture) | `7974008` |
| Execution foundation, unwired (phase 2a) | `3c3076e` |
| Execution wired (phase 2b) | uncommitted |

## Current phase

**Safe execution, complete.** `rasterwright fix` executes plans. See `04`
section 18 for the decisions behind this phase, and section 17 for the
foundation it was built on.

Landed in 2b:

- `operations/execute.ts`: per-file orchestration. Reads the original once,
  renders the candidate into a Buffer, inspects it with `inspectBuffer` under
  the *target* path, evaluates it against the target path's effective rule, and
  only then writes. `skipReasonFor()`, `statusForSkip()` and `verifyCandidate()`
  are pure and unit-tested without a filesystem.
- `runFix()` in `run-fix.ts`: preconditions, startup recovery and sweep, signal
  handlers, bounded concurrency, the report. `planRun` is shared with the dry
  run, so the executor runs against the plan set the dry run described.
- `operations/backup.ts`: `--backup-dir`, mirrored not flattened, refusing to
  overlap the project or to overwrite a backup of differing bytes.
- `utils/signal.ts`: first SIGINT sets a flag, in-flight writes complete, temp
  cleanup happens after the worker pool drains, second signal exits.
- `cli/render/fix.ts` and `cli/render/common.ts`: the fix report, exceptions
  first, sharing the plan renderer's layout helpers and `renderOperation`.
- `--no-git` and `--backup-dir` on the `fix` command; the git precondition and
  per-file dirty/untracked/ignored warnings.
- `RASTERWRIGHT_STALL_MS`, a third test-only hook in `atomic.ts`, so the SIGINT
  test fires at a deterministic edge.
- `FixReport.unrecovered`, and `FixSummary.bytesBefore/After` documented as
  covering only the files that changed.
- A new fixture project, `conversion`: format conversion end to end, with real
  transparency to preserve. It reaches a clean `check` after one run, which
  makes it the project the strict idempotence procedure runs against.

Also landed, from the review pass over 2b (`04` section 18, items 12 to 18):
a stale-plan guard, a catch-all so `executeFile` cannot throw, honest quality
wording in the fix report, write-scoped git and sweep sets, lazy `--backup-dir`
creation, reported temp residue, `--json` on an exit 2, and strict command-line
validation.

Status: 2b complete and green.

## Non-negotiable invariants

- `check` and `fix --dry-run` write nothing: no bytes, mtimes, names,
  config, cache, `.rasterwright/`. Integration tests snapshot the tree.
- A refused `fix` writes nothing either. Preconditions run before the startup
  sweep, which is itself a write.
- `planFile()` is pure, deterministic, file-local: no Sharp, no fs.
- One file, one coherent plan, exactly one `encode`. Operation order:
  autoOrient, resize, toColorSpace, encode, rename.
- Idempotence: second `fix` run writes zero files. The file's current state
  is the only source of truth. No hidden provenance metadata in images.
- Original stays byte-for-byte untouched until a candidate has been
  generated, inspected and verified against policy. Explicit failure over
  degraded output. No best-effort PNG, no palette quantization, no flatten
  without explicit policy.
- Failure is per file. A file either fully succeeds or is left exactly as it
  was, so there is no partial state and no rollback machinery.
- Preflight refuses conservatively: it never picks a winner between two plans
  claiming one path, and never orders renames so a chain can thread itself.
- Any filename change requires `--allow-renames` per run. Not a config key.
  Without it the whole file is blocked, never partially fixed.
- `maxBytes` is a ceiling, not a target. Dry-run never predicts a size.
- Metadata (EXIF/XMP/IPTC/text) is a warning, stripped only during a rewrite
  an error already required. ICC is colour management, not metadata.
- `kb` = 1024 bytes. Rules shallow-merge, later matching rule wins per key.

## Recent decisions (not already in 04)

- None beyond `04` sections 15, 16, 17 and 18.

## Known limitations

- **Byte budgets are not enforced.** A plan whose encode exists to satisfy
  `maxBytes` (`EncodeOperation.budgetDriven`) is `skipped` before anything is
  encoded. A ceiling that merely also applies to a rewrite something else
  required *is* enforced, and a candidate over it is `failed` with a message
  saying the search does not exist yet. This is the next phase.
- The case-only rename is unreachable from the planner today.
  `pathForFormat()` leaves the path alone when the current extension already
  denotes the target format (`plan.ts:283`), so `a.JPG` under `format: jpeg`
  never becomes `a.jpg`, and no policy produces a case-only target.
  `needsTwoStepRename`, `movingNameFor` and `recoverInterruptedMoves` are
  therefore defence for a planner that has not been written yet: keep their
  unit tests, keep calling recovery at startup, and do not spend an afternoon
  trying to build an integration fixture for it.
- A rename-only plan re-inspects the source bytes to evaluate them under the
  target path. That is a second decode of a file nothing is re-encoding.
  Correct, and cheap enough not to have optimized.
- **Path semantics come from `process.platform`, not from the mounted
  filesystem.** `defaultPathSemantics()` calls macOS and Windows
  case-insensitive and everything else case-sensitive. A case-sensitive volume
  on macOS, or a case-insensitive one mounted on Linux, is therefore judged
  wrong. The error only ever refuses a batch that would have worked, or takes
  the two-step rename route where a direct one would do, so it is safe in the
  direction it fails - but probing the filesystem would be the honest answer.
- **A symlinked image is invisible.** Discovery does not follow symlinks, so a
  link under a governed glob is counted as "matched no rule and was skipped"
  rather than as a link, and nothing is ever written through one. That is the
  safe behaviour and the wrong label: the summary line says the file is
  ungoverned when the truth is that Rasterwright declined to follow it. It
  deserves its own count and message.
- **A read-only file is still replaced.** `fix` writes through a rename, and
  renaming into a directory needs write permission on the *directory*, not on
  the file. A `0444` image whose parent directory is writable is overwritten
  without complaint. The new file keeps the original's mode, so the result is
  still `0444`; only the contents changed.
- **A hardlinked image loses its link.** The atomic rename replaces the
  directory entry rather than the inode, so a file with two names ends up with
  the fixed bytes under one name and the original bytes under the other. That is
  the same trade every atomic writer makes, and the alternative - writing in
  place - gives up crash safety for every file to preserve a link almost nobody
  has.
- A subdirectory the process cannot read (`chmod 000`) is silently skipped by
  discovery, so `complete` can overstate coverage. Discovery uses
  `suppressErrors: true`; it should report unreadable directories.
- Dotfiles and dot-directories are invisible to discovery (`dot: false`), so
  images under them are never governed.
- Running the CLI directly inside this checkout against `fixtures/projects/*`
  finds nothing without `--no-gitignore`: the repo `.gitignore` excludes the
  generated fixture images. Tests copy each project to a temp directory
  instead, which is why they are unaffected.
- PNG `tEXt` metadata is not reliably detectable through Sharp/libspng;
  fixtures cannot generate it.
- Glob matching is case-sensitive on macOS and Linux for determinism
  (case-insensitive on Windows); collision folding is separate, see `04` 16.4.
- Animated images are `unsupported`, never processed frame-by-frame.
- 16-bit images are `unsupported` for anything that would re-encode them,
  because Sharp's encoders write 8 bits per channel. A rename-only plan on one
  is still performed. See `04` 17.12 and 18.1.
- An indexed (palette) PNG is re-encoded truecolour and can come out roughly
  three times its original size. `palette: true` is only lossless while the
  colour count is unchanged, which a resize breaks, so the byte-budget phase
  has to decide this rather than the pipeline. It will likely want a palette
  flag on `ImageInfo`. See `04` 17.18.
- Renaming onto an existing path is refused immediately before the rename, but
  a microsecond TOCTOU window remains between the check and the rename.
  `rename(2)` has no portable fail-if-exists mode. See `04` 17.14.
- No before-copies. Deferred to `review`; the call site in `executeFile()` is
  marked. See `04` 17.7.

## Roadmap (in order)

1. Batch preflight (done)
2. Safe execution (done: 2a foundation, 2b wiring)
3. (folded into 2a) Deterministic operations through one Sharp pipeline
4. Byte-budget execution: quality search JPEG/WebP, lossless PNG attempt,
   explicit failure. The next phase.
5. Idempotence hardening tests
6. `review` (static HTML, before-copies, exceptions first)
7. `init`
8. Agent-facing docs (SKILL.md), packaging polish

## Human validation pending

- Real `fix` execution against `~/bokka-theme-env/wp-content/themes/bokka-theme`.
  Nothing in this session touched that checkout. A human should run
  `fix --dry-run` there first, read the plan, and only then run `fix` on a
  clean git working tree.
