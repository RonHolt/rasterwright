# Rasterwright Implementation Status

**Purpose:** durable current-state record for future sessions. Read this
right after `CLAUDE.md`. It is rewritten at the end of each phase, not
appended to. Product scope lives in `03`, architecture in `04`, user-facing
behaviour in `README.md`; this file only records where the implementation is.

## Current state

- HEAD: `7974008 feat: add batch plan preflight`
- Implemented commands: `check` (`--verbose`, `--json`), `fix --dry-run`
  (`--json`, `--allow-renames`). Plain `fix` exits 2: execution not built.
- Not implemented: `fix` execution, `review`, `init`.
- Baseline: 341 tests across 12 files, `npm run typecheck` clean,
  `npm run build` clean.
- Sharp pinned exactly at `0.35.4`.

## Completed phases

| Phase | Commit |
|---|---|
| Read-only `check` | `a8b3332` |
| Severity + real-world check refinements | `b3b312b`, `75dbc63` |
| Read-only `fix --dry-run` (pure planner) | `2860c4e` |
| Batch plan preflight (`blocked` status, collisions fixture) | `7974008` |

## Current phase

**Safe execution foundation.** Filesystem/transaction layer for real
`fix`: candidate generated in memory, inspected and verified against the
effective policy, then written to a temp file in the same directory,
fsynced, atomically renamed over the destination (new path first, then
unlink old on format conversion). Per-file failure isolation, SIGINT
cleanup, stale temp cleanup, preserved file mode, bounded concurrency,
git-dirty warning, `--no-git` / `--backup-dir` outside a repo. No byte
budget search yet. Status: not started.

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

- None beyond `04` sections 15 and 16.

## Known limitations

- Preflight refuses rename chains rather than ordering them. Deliberate;
  see `04` section 16.3.
- A subdirectory the process cannot read (`chmod 000`) is silently skipped by
  discovery, so `complete` can overstate coverage. Discovery uses
  `suppressErrors: true`; it should report unreadable directories.
- Dotfiles and dot-directories are invisible to discovery (`dot: false`), so
  images under them are never governed.
- A case-only self-rename (`a.JPG` -> `a.jpg`) stays `planned` under
  case-insensitive semantics, because the target *is* its own source. The
  executor must perform it as a two-step rename through a temporary name;
  a direct rename is a no-op on macOS and Windows.
- Running the CLI directly inside this checkout against `fixtures/projects/*`
  finds nothing without `--no-gitignore`: the repo `.gitignore` excludes the
  generated fixture images. Tests copy each project to a temp directory
  instead, which is why they are unaffected.
- PNG `tEXt` metadata is not reliably detectable through Sharp/libspng;
  fixtures cannot generate it.
- Glob matching is case-sensitive on macOS and Linux for determinism
  (case-insensitive on Windows); collision folding is separate, see `04` 16.4.
- Animated images are `unsupported`, never processed frame-by-frame.

## Roadmap (in order)

1. Batch preflight (done, uncommitted)
2. Safe execution foundation: temp file in same dir, fsync, atomic rename,
   verify candidate before commit, per-file failure isolation, SIGINT
   cleanup, git-dirty warning, `--no-git` / `--backup-dir` outside git
3. Deterministic operations through one Sharp pipeline: autoOrient, resize,
   colour, same-format and cross-format encode, metadata strip on rewrite,
   alpha preservation, rename-only extension correction
4. Byte-budget execution: quality search JPEG/WebP, lossless PNG attempt,
   explicit failure
5. Idempotence hardening tests
6. `review` (static HTML, before-copies, exceptions first)
7. `init`
8. Agent-facing docs (SKILL.md), packaging polish

## Human validation pending

- Real `fix` execution against `~/bokka-theme-env/wp-content/themes/bokka-theme`
  (read-only `check` / `fix --dry-run` only until a human runs it).
