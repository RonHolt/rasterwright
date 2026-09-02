# Rasterwright Implementation Status

**Purpose:** durable current-state record for future sessions. Read this
right after `CLAUDE.md`. It is rewritten at the end of each phase, not
appended to. Product scope lives in `03`, architecture in `04`, user-facing
behaviour in `README.md`; this file only records where the implementation is.

## Current state

- HEAD: `ec61d21 docs: record preflight phase as complete in implementation status`
  plus uncommitted work on the execution foundation (phase 2a).
- Implemented commands: `check` (`--verbose`, `--json`), `fix --dry-run`
  (`--json`, `--allow-renames`). Plain `fix` exits 2: execution not built.
- Not implemented: `fix` execution, `review`, `init`.
- Baseline: 497 tests across 15 files, `npm run typecheck` clean,
  `npm run build` clean.
- Sharp pinned exactly at `0.35.4`.

## Completed phases

| Phase | Commit |
|---|---|
| Read-only `check` | `a8b3332` |
| Severity + real-world check refinements | `b3b312b`, `75dbc63` |
| Read-only `fix --dry-run` (pure planner) | `2860c4e` |
| Batch plan preflight (`blocked` status, collisions fixture) | `7974008` |
| Execution foundation, unwired (phase 2a) | uncommitted |

## Current phase

**Safe execution foundation, part 2 of 2.** Part 1 (2a) is done and
uncommitted: the building blocks exist with unit tests and are deliberately
**not wired**, so plain `fix` still exits 2 and the read-only guarantees are
unchanged. See `04` section 17 for the decisions behind them.

Landed in 2a:

- `inspectBuffer()` split out of `inspect()`, so a candidate is verified from
  bytes that never touched disk, by the same inspector the read path uses.
- `planRun()` split out of `runFixPlan()`, so execution and the dry run share
  one preflight rather than two copies of `surveyTargets`.
- `operations/pipeline.ts`: one Sharp chain per plan, one `toBuffer()`. Colour,
  metadata and orientation handling verified against real pixels.
- `operations/atomic.ts`: temp file in the same directory, fsync, atomic
  rename, parent-directory fsync, mode preserved, rename-then-unlink on
  conversion, refusal to rename onto an occupied path, `TempRegistry` for
  SIGINT, stale temp sweep that skips live pids, two-step case-only rename with
  `recoverInterruptedMoves()`.
- `operations/git.ts`: repository detection and per-path clean / modified /
  untracked / ignored classification, degrading to `unknown` rather than to
  "clean".
- A planner fix, the only shipped behaviour change: an encode forced by another
  error under `autoOrient: false` now preserves the orientation flag instead of
  silently rotating the image. `04` section 17.1.
- `ImageInfo.bitDepth`, and a second planner change: a 16-bit source whose plan
  would encode is `unsupported` rather than silently flattened to 8 bits.
  `check --json` gained the field.
- `FixStatus`, `FixResult`, `FixSummary` and `FixReport` in `types.ts`, unused
  until 2b wires them.

Still to do in 2b:

- `operations/execute.ts` and `runFix()`: per-file orchestration, candidate
  verification against the effective policy of the *target* path, per-file
  failure isolation, budget-driven plans refused up front.
- CLI wiring, SIGINT handling, startup stale sweep, the git-dirty warning and
  the `--no-git` / `--backup-dir` refusal outside a repository.
- Integration and idempotence tests, including the zero-bytes-written assertion
  via `RASTERWRIGHT_TRACE_WRITES`.
- Calling `recoverInterruptedMoves()` and `sweepStaleTemps()` at startup and
  reporting both as diagnostics.
- Reporting a truncated JPEG, which only fails at decode time inside the
  pipeline, as `failed` with the decoder's message.

Status: 2a complete and green, 2b not started.

## Non-negotiable invariants

- `check` and `fix --dry-run` write nothing: no bytes, mtimes, names,
  config, cache, `.rasterwright/`. Integration tests snapshot the tree.
- `planFile()` is pure, deterministic, file-local: no Sharp, no fs.
- One file, one coherent plan, exactly one `encode`. Operation order:
  autoOrient, resize, toColorSpace, encode, rename.
- Idempotence: second `fix` run writes zero files. The file's current state
  is the only source of truth. No hidden provenance metadata in images.
- Original stays byte-for-byte untouched until a candidate has been
  generated, inspected and verified against policy. Explicit failure over
  degraded output. No best-effort PNG, no palette quantization, no flatten
  without explicit policy.
- Preflight refuses conservatively: it never picks a winner between two plans
  claiming one path, and never orders renames so a chain can thread itself.
- Any filename change requires `--allow-renames` per run. Not a config key.
  Without it the whole file is blocked, never partially fixed.
- `maxBytes` is a ceiling, not a target. Dry-run never predicts a size.
- Metadata (EXIF/XMP/IPTC/text) is a warning, stripped only during a rewrite
  an error already required. ICC is colour management, not metadata.
- `kb` = 1024 bytes. Rules shallow-merge, later matching rule wins per key.
- Plain `fix` keeps refusing until a verified executor exists.

## Recent decisions (not already in 04)

- None beyond `04` sections 15, 16 and 17.

## Known limitations

- Preflight refuses rename chains rather than ordering them. Deliberate;
  see `04` section 16.3.
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
  is still performed. See `04` 17.12.
- An indexed (palette) PNG is re-encoded truecolour and can come out roughly
  three times its original size. `palette: true` is only lossless while the
  colour count is unchanged, which a resize breaks, so the byte-budget phase
  has to decide this rather than the pipeline. It will likely want a palette
  flag on `ImageInfo`. See `04` 17.18.
- A truncated JPEG passes `inspect()`, because `metadata()` reads the header
  without decoding. The pipeline's `failOn: 'error'` catches it at
  `toBuffer()`, and 2b must report it as `failed`. See `04` 17.18.
- Renaming onto an existing path is refused immediately before the rename, but
  a microsecond TOCTOU window remains between the check and the rename.
  `rename(2)` has no portable fail-if-exists mode. See `04` 17.14.

## Roadmap (in order)

1. Batch preflight (done)
2. Safe execution foundation. 2a done: the Sharp pipeline, the atomic writer,
   the git survey, `inspectBuffer`, `planRun`, and the orientation fix, all
   unwired. 2b remaining: `execute.ts`, `runFix`, CLI wiring, SIGINT, the
   startup sweep, the git-dirty warning and `--no-git` / `--backup-dir`
3. (folded into 2a) Deterministic operations through one Sharp pipeline
4. Byte-budget execution: quality search JPEG/WebP, lossless PNG attempt,
   explicit failure
5. Idempotence hardening tests
6. `review` (static HTML, before-copies, exceptions first)
7. `init`
8. Agent-facing docs (SKILL.md), packaging polish

## Human validation pending

- Real `fix` execution against `~/bokka-theme-env/wp-content/themes/bokka-theme`
  (read-only `check` / `fix --dry-run` only until a human runs it).
