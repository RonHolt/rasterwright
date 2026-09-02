# Rasterwright Implementation Status

**Purpose:** durable current-state record for future sessions. Read this
right after `CLAUDE.md`. It is rewritten at the end of each phase, not
appended to. Product scope lives in `03`, architecture in `04`, user-facing
behaviour in `README.md`; this file only records where the implementation is.

## Current state

- HEAD: `21f0b5a docs: record byte-budget phase as complete in implementation
  status`, plus uncommitted work implementing `review`.
- Implemented commands: `check` (`--verbose`, `--json`), `fix --dry-run`
  (`--json`, `--allow-renames`), `fix` (`--allow-renames`, `--json`,
  `--no-git`, `--backup-dir`, `--no-review`, `--concurrency`), and `review`
  (`--keep`, `--clean`, `--no-open`). Byte budgets are enforced.
- Not implemented: `init`.
- Baseline: 703 tests across 22 files, `npm run typecheck` clean,
  `npm run build` clean.
- Sharp pinned exactly at `0.35.4`.
- The vertical-slice loop from `04` section 11 is closed: check, fix, check
  again clean, fix again writing nothing, and a before/after page.

## Completed phases

| Phase | Commit |
|---|---|
| Read-only `check` | `a8b3332` |
| Severity + real-world check refinements | `b3b312b`, `75dbc63` |
| Read-only `fix --dry-run` (pure planner) | `2860c4e` |
| Batch plan preflight (`blocked` status, collisions fixture) | `7974008` |
| Execution foundation, unwired (phase 2a) | `3c3076e` |
| Execution wired (phase 2b) | `9e7195f` |
| Byte-budget execution | `7460214`, `21f0b5a` |
| `review` (before-copies, manifest, static page) | uncommitted |

## Current phase

**`rasterwright init`.** A starter `.rasterwright.yml` generated from what a
repo already contains: one scan, a handful of conservative heuristics, no
interactive prompts, `--bare` for a plain commented template, and the
`.rasterwright/` line written into `.gitignore` (the one command permitted to
touch it). Status: not started. See `03` section 3 and `04` section 9.

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
  was, so there is no partial state and no rollback machinery. That includes a
  before-copy that cannot be written: the file fails and the original stands.
- Preflight refuses conservatively: it never picks a winner between two plans
  claiming one path, and never orders renames so a chain can thread itself.
- Any filename change requires `--allow-renames` per run. Not a config key.
  Without it the whole file is blocked, never partially fixed.
- `maxBytes` is a ceiling, not a target. Dry-run never predicts a size.
- Metadata (EXIF/XMP/IPTC/text) is a warning, stripped only during a rewrite
  an error already required. ICC is colour management, not metadata.
- `kb` = 1024 bytes. Rules shallow-merge, later matching rule wins per key.
- A second, idempotent `fix` leaves `.rasterwright/` byte-identical and adds no
  before-copy. A run records itself only when it actually wrote a file.
- Rasterwright never edits `.gitignore` outside `init`. `fix` suggests a line
  and nothing more.

## Recent decisions (not already in 04)

- None beyond `04` sections 15, 16, 17, 18, 19 and 20.

## Known limitations

- **A byte budget is met by quality alone.** There is no extra downscale and no
  format fallback: the plan fixes the dimensions and the output format before
  any encoding starts, and both would make those depend on encoder results. A
  ceiling the quality floor cannot reach is an explicit failure naming the three
  manual remedies. See `04` 19.8.
- **A ceiling applies to every encode under its rule, not only budget-driven
  ones.** A file being rewritten for some other reason under a rule that sets
  `maxBytes` is also searched when the start quality overshoots, so it can land
  at a lower quality and a smaller size than it did before this phase. Intended,
  and a real change in output bytes. See `04` 19.11.
- **The search costs a full decode per probe.** libvips re-decodes the source on
  every `toBuffer()`. Measured at roughly 185 ms per probe on the worst fixture,
  so about 1.1 s for a six-probe search. Decoding once to raw pixels would be
  faster and would change the ICC handling path, so it is deliberately not done.
  See `04` 19.7.
- **A conversion is judged where it lands.** The `maxBytes` and `quality` the
  encode uses come from the rule governing the *output* path, because that is
  the rule verification applies. The source rule still decides `format`,
  `colorSpace`, `stripMetadata` and `autoOrient`; size limits take the tighter
  of the two. A limit only the destination imposes rides along with a rewrite
  and never causes one, so a pixel-free rename stays pixel-free. A target path
  matching no rule has no ceiling. See `04` 19.12.
- **The search can miss a fitting quality on a non-monotone size curve**, and in
  the worst case report a failure where one existed. It can never write bytes
  over the ceiling. Measured over 20,000 synthetic curves: 314 missed optima, no
  false failures, no over-ceiling writes. See `04` 19.3.
- **Each probe copies the source buffer.** Sharp's `clone()` runs
  `structuredClone` over its options, which for buffer input duplicates the
  whole source: 457 KB per clone on `overbudget.jpg`. One clone is live at a
  time, so peak memory is bounded, but churn scales as probes x source size x
  concurrency. See `04` 19.7.
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
  three times its original size, and a byte budget on one has no answer beyond
  the explicit failure. The byte-budget phase decided *not* to add a palette
  flag: `sharp().metadata()` exposes `isPalette` cheaply, but `palette: true`
  routes through imagequant regardless of the input and is lossless only while
  the colour count is unchanged, which nothing in the metadata guarantees.
  Revisit as its own phase, with a raw-pixel equality check as the correctness
  argument and a genuinely indexed fixture, which the corpus does not have.
  See `04` 17.18 and 19.9.
- Renaming onto an existing path is refused immediately before the rename, but
  a microsecond TOCTOU window remains between the check and the rename.
  `rename(2)` has no portable fail-if-exists mode. See `04` 17.14.
- **Before-copies cost one copy of every original a run overwrites.** Bounded by
  `retain`, which defaults to one run, but a first run over a photo-heavy
  project can be hundreds of megabytes. `review` prints the size of the store
  and names `--clean`; it does not warn above a threshold.
- **Two concurrent `fix` runs over one project can lose one run's manifest
  entry.** The manifest is a read-merge-write at the end of a run, and the
  window is microseconds wide. A lock file would close it and is not worth the
  machinery. See `04` 20.2.
- **A hard second SIGINT skips the manifest write.** That run's before-copies
  are hash-named and unreferenced, so the next prune collects them. Correct
  outcome, no extra code.
- **A page with two hundred cards is a heavy page.** Lazy loading and
  exceptions-first make it usable, not small. The agent-vision contact sheet
  from `04` section 12 stays deferred.
- **`review` has no `--json`.** The manifest is already stable JSON at a known
  path, and a second serialization that drifts is worse than none. See `04`
  20.12.
- **The review page is only ever as current as its last render.** `review`
  detects an output that changed or vanished since the run and says so, but it
  does not re-render itself; a page left open shows what it showed.
- **A copy of an image is a copy of an image.** Anything sensitive in the repo
  is now also under `.rasterwright/`, which is why the ignore hint matters and
  why `review --clean` is a first-class command rather than an afterthought.

## Roadmap (in order)

1. Batch preflight (done)
2. Safe execution (done: 2a foundation, 2b wiring)
3. (folded into 2a) Deterministic operations through one Sharp pipeline
4. Byte-budget execution (done): quality search JPEG/WebP, lossless PNG attempt,
   explicit failure.
5. Idempotence hardening tests (done, folded into the phases above)
6. `review` (done): static HTML, before-copies, exceptions first
7. `init` (current)
8. Agent-facing docs (SKILL.md), packaging polish

## Human validation pending

- Real `fix` execution against `~/bokka-theme-env/wp-content/themes/bokka-theme`.
  Nothing in this session touched that checkout. A human should run
  `fix --dry-run` there first, read the plan, and only then run `fix` on a
  clean git working tree.
- **The review page under a human eye.** It has now been driven headlessly - the
  page loads with no console errors, all thirteen images resolve, and the
  overlay, zoom dialog, per-pane buttons, filters and `/` shortcut all behave -
  but nobody has yet looked at it and judged whether the comparison is actually
  useful at a glance. That is the remaining question, and it is a design one
  rather than a correctness one.
