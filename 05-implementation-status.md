# Rasterwright Implementation Status

**Purpose:** durable current-state record for future sessions. Read this right
after `CLAUDE.md`. It is rewritten at the end of each phase, not appended to.
Product scope lives in `03`, architecture in `04`, user-facing behaviour in
`README.md`; this file only records where the implementation is.

## Current state

- HEAD: `d9105e8 fix: only loosen a limit the rule is actually failing`. The
  last implementation phase was `c39f2eb`, the packaging and agent-docs work;
  everything since is validation and the fixes it turned up.
- **All four v0 commands are implemented.** `init` (`--bare`, `--force`,
  `--config`, `--keep-gitignore`, `--no-gitignore`, `--concurrency`), `check`
  (`--verbose`, `--json`), `fix --dry-run` (`--json`, `--allow-renames`), `fix`
  (`--allow-renames`, `--json`, `--no-git`, `--backup-dir`, `--no-review`,
  `--concurrency`), `review` (`--keep`, `--clean`, `--no-open`). Byte budgets
  enforced. Baseline: 891 tests across 26 files, typecheck and build clean.
  Sharp pinned exactly at `0.35.4`. The vertical-slice loop (`04` section 11)
  is closed: check, fix, check clean, fix again writing nothing, before/after
  page; `init` closes the other end by generating a config where none exists.
- **Installs as a package and ships an agent skill.** `npm pack`: 59 files, 123
  kB tarball (390 kB unpacked) - `dist/` (no source maps), `skills/`,
  `README.md`, `LICENSE`, `package.json`. Verified via `npm install <tarball>`
  through the full init/check/fix/review loop; sharp's native binary loads from
  the installed location. See `04` section 22. `skills/rasterwright/SKILL.md`
  teaches an agent the CLI contract: the check/dry-run/fix/check loop, `--json`
  field names, and the two things never to do (edit the policy to clear a
  finding, or hand-roll a sharp script for a governed image).

## Completed phases

| Phase | Commit |
|---|---|
| Read-only `check` | `a8b3332` |
| Severity + real-world check refinements | `b3b312b`, `75dbc63` |
| Read-only `fix --dry-run` (pure planner) | `2860c4e` |
| Batch plan preflight (`blocked` status, collisions fixture) | `7974008` |
| Execution foundation + wiring (phases 2a/2b) | `3c3076e`, `9e7195f` |
| Byte-budget execution | `7460214`, `21f0b5a` |
| `review` (before-copies, manifest, static page) | `dec36dd` |
| `init` (scan, heuristic, templates, gitignore) | `3c73dbc` |
| Packaging and agent-facing docs | `c39f2eb` |

## Current phase

**The v0 roadmap is complete; next is human validation.** `c39f2eb` was the
last phase (see Completed phases above); no further implementation phase is
queued. Decisions in `04` section 22 - see Human validation pending below.

## Non-negotiable invariants

- `check` and `fix --dry-run` write nothing: no bytes, mtimes, names, config,
  cache, `.rasterwright/` (integration tests snapshot the tree); a refused
  `fix` writes nothing either, since preconditions run before the startup
  sweep, itself a write.
- `planFile()` is pure, deterministic, file-local (no Sharp, no fs): one file,
  one coherent plan, exactly one `encode`, in order autoOrient, resize,
  toColorSpace, encode, rename. Idempotence: a second `fix` writes zero files
  and leaves `.rasterwright/` byte-identical, adding no before-copy - a run
  records itself only when it actually wrote a file, and the file's current
  state is the only source of truth, with no hidden provenance metadata in
  images.
- Original stays byte-for-byte untouched until a candidate is generated,
  inspected and verified against policy - explicit failure over degraded output
  (no best-effort PNG, no palette quantization, no flatten without explicit
  policy). Failure is per file: full success or left exactly as it was, no
  partial state and no rollback machinery, including a before-copy that can't
  be written, where the file fails and the original stands.
- Preflight refuses conservatively: never picks a winner between two plans
  claiming one path, never orders renames so a chain can thread itself. Any
  filename change requires `--allow-renames` per run, not a config key; without
  it the whole file is blocked, never partially fixed.
- `maxBytes` is a ceiling, not a target (dry-run never predicts a size); `kb` =
  1024 bytes; rules shallow-merge, later matching rule wins per key. Metadata
  (EXIF/XMP/IPTC/text) is a warning, stripped only during a rewrite an error
  already required; ICC is colour management, not metadata.
- Rasterwright never edits `.gitignore` outside `init` (`fix` only suggests a
  line). `init` writes exactly one file it was asked for, plus `.gitignore` in
  a git work tree - no directories, no `.rasterwright/`. `run-init.ts` writes
  nothing; `cli/init.ts` is the only writer. A generated config is validated
  through the real loader *before* it is written, never after; `init` never
  emits `format` or `maxHeight`, and a generated glob escapes picomatch syntax
  in directory names, is written as a single-quoted YAML scalar, and carries
  every extension spelling the scan saw. See `04` 21.3.

## Recent decisions (not already in 04)

- None beyond `04` sections 15-24. Section 23 is the searched-down quality
  validation: what the floor of 40 actually looks like, why a byte ceiling is a
  weak lever on flat-colour art, the planner/pipeline resize disagreement it
  exposed, and the failure message that printed a ceiling and the size that
  missed it as the same number. Section 24 is the `init` taste pass on
  unfamiliar repositories: the roll-up that gave up at four top-level image
  directories, and the closure loop that walked a ladder with no violations on
  it.

## Known limitations

- `init --config` sets the project root (globs are relative to its directory,
  so `/tmp/x.yml` scans `/tmp` - a read-only trial against a repo you can't
  write to must call `runInit` directly), and inspects every image, governed or
  not, since coverage isn't known until all are seen (1.1 s for 76 images on
  the real theme).
- The byte ladder almost never moves (fires only after the width ladder tops
  out - intended, see `04` 21.2); a group under three images is left ungoverned
  (counted, named in a comment); and the generated config describes the
  repository, not an intention - ladder numbers, not direct measurement, but
  equally authoritative-looking. `MAX_RULES` is a preference, not a promise: a
  repository with more than three top-level image directories gets one rule per
  directory rather than the single broad rule the roll-up used to collapse to,
  and only a corpus too thin to clear `MIN_GROUP` still collapses (`04` 24.1).
  The width ladder's bottom rung is 640, so a directory of icons gets an inert
  width limit (`04` 24.3).
- Quality is a weak lever on flat-colour art: across the whole 40-82 band a
  logo and a flat vector illustration span a factor of 1.2 in bytes where a
  photograph spans 2.1. A byte ceiling on that kind of file either fits near
  the top of the band or cannot be reached at all, and the floor can never be
  reached by a budget (see `04` 23.2).
- A byte budget is met by quality alone (dimensions/format fixed before
  encoding; an unreachable ceiling fails explicitly, naming three manual
  remedies, see `04` 19.8), applies to every encode under its rule, not just
  budget-driven ones (see `04` 19.11), and is judged where the conversion
  lands: `maxBytes`/`quality` from the output rule, `format`/`colorSpace`/
  `stripMetadata`/`autoOrient` from the source rule, tighter limit wins, an
  unmatched target has no ceiling (see `04` 19.12). The search itself costs a
  full decode and a buffer copy per probe (~185 ms worst case, ~1.1 s for six
  probes; 457 KB per clone via `structuredClone` on `overbudget.jpg`; churn
  scales as probes x source size x concurrency, see `04` 19.7), and can miss a
  fitting quality on a non-monotone curve without ever writing over the ceiling
  (314 misses in 20,000 synthetic curves, no false failures, see `04` 19.3).
- PNG re-encoding is one deflate pass, not an optimizer: with
  `adaptiveFiltering` on it beats the source on gradient-heavy truecolour RGBA
  (330 KB to 142 KB on the `screenshot.png` fixture) but it runs no
  zopfli/oxipng-style search, so a lossless re-encode can still come back no
  smaller than the file already is, and the refusal says which of the two
  happened; WebP is roughly 10x smaller on the same files (see `04` 19.13).
- The case-only rename is unreachable from the planner (`pathForFormat()`
  leaves the path alone once the extension matches the target format);
  `needsTwoStepRename`, `movingNameFor`, `recoverInterruptedMoves` defend a
  planner not yet written - keep the tests, skip an integration fixture. Path
  semantics also come from `process.platform`, not the mounted filesystem, so a
  case-sensitive volume on macOS (or case-insensitive one on Linux) is judged
  wrong, but safely.
- Several file types behave unexpectedly: a symlinked image is invisible to
  discovery (counted as ungoverned rather than a skipped link); a read-only
  file is still replaced (renaming needs write permission on the directory, not
  the file; mode is preserved); a hardlinked image loses its link (atomic
  rename replaces the directory entry, not the inode); an unreadable
  subdirectory (`chmod 000`) is silently skipped (`suppressErrors: true`); and
  dotfiles/dot-directories are invisible (`dot: false`).
- Running the CLI directly in this checkout against `fixtures/projects/*` finds
  nothing without `--no-gitignore` (tests copy to a temp directory instead);
  PNG `tEXt` metadata isn't reliably detectable through Sharp/libspng, so
  fixtures can't generate it; and glob matching is case-sensitive on
  macOS/Linux, case-insensitive on Windows (collision folding is separate, see
  `04` 16.4). Animated images are `unsupported`, as are 16-bit images for
  anything that would re-encode them (rename-only still runs, see `04` 17.12,
  18.1); an indexed (palette) PNG is re-encoded truecolour, tripling its size,
  with no byte-budget answer beyond explicit failure - no palette flag added,
  since `palette: true` is lossless only if colour count is unchanged, which
  metadata can't guarantee (see `04` 17.18, 19.9).
- Renaming onto an existing path has a microsecond TOCTOU window (`rename(2)`
  has no fail-if-exists mode, see `04` 17.14); two concurrent `fix` runs can
  similarly lose a manifest entry (not worth a lock file, see `04` 20.2), and a
  hard second SIGINT skips the write too, though orphaned before-copies get
  pruned next run. Before-copies themselves cost one copy of every overwritten
  original, bounded by `retain` (default one run) but potentially hundreds of
  MB on a first, photo-heavy run; `review` reports store size and names
  `--clean`.
- The review page has real limits: no `--json` (the manifest is already stable
  JSON, see `04` 20.12); only as current as its last render, flagging a changed
  or vanished output rather than re-rendering; and two hundred cards makes for
  a heavy but usable page (lazy loading, exceptions-first - the agent-vision
  contact sheet from `04` section 12 stays deferred). A copy of an image is a
  copy of an image, so anything sensitive in the repo is now also under
  `.rasterwright/`, hence the ignore hint and `review --clean`.

## Roadmap (in order)

All complete, in order (see Completed phases above for commits and detail): (1)
batch preflight; (2) safe execution (2a foundation, 2b wiring); (3, folded into
2a) deterministic operations through one Sharp pipeline; (4) byte-budget
execution; (5) idempotence hardening tests (folded into the phases above); (6)
`review`; (7) `init`; (8) agent-facing docs and packaging polish.

## Human validation pending

Done on 2026-09-02 against the real theme
(`~/bokka-theme-env/wp-content/themes/bokka-theme`), by Ron:

- `check` found the four known problems; `fix --allow-renames` renamed the
  mislabelled logo, resized and re-encoded the JPEG (366 KB to 272 KB at
  quality 82), and failed both oversized PNGs honestly; `check` then had no
  errors; a second `fix` traced zero writes; `review` opened in the browser
  and read well at first glance.
- The PNG failures exposed a real encoder gap (no adaptive filtering, fixed
  in `058f3cc`). The correct policy was `format: webp` for those files; that
  rule converted both at quality 82 with transparency intact, 91% smaller,
  and a second run again wrote nothing.
- Two CLI bugs found and fixed on the way: EPIPE crash when stdout closed
  early (`fe7fd28`), and a review flag calling a format conversion a
  quality drop (`058f3cc`).

Done on 2026-09-02, second pass, on a lab copy of four real specimens at four
budget tiers (`04` section 23):

- **The floor of 40 is acceptable on all four content types** - photograph,
  fine-text logo, photographic gradient, flat vector illustration - judged at
  1:1 and at 2x zoom. It was reached by a budget on the gradient (q41) and
  forced outright in a fourth tier for the two specimens whose curves are too
  flat for a budget to push them there. The photograph's survival at 40 is
  mozjpeg's trellis quantization doing the work, so the floor is calibrated
  for that encoder.
- Two real bugs fixed on the way: the planner named resize dimensions the file
  never got (1600x625 planned, 1598x625 written), and an unreachable-ceiling
  failure printed the ceiling and the best attempt as the same number.
- The overlay and 1:1 zoom modes on the review page do their job well.

Done on 2026-09-02, third pass, `init` run read-only against repositories whose
policy was never hand-written (`04` section 24):

- Trials on a legacy client theme (`chinburg`, 651 images, four top-level image
  directories) and an Astro static site (`portfolio`, 593 images, 30 MB source
  photographs), plus a discovery-only sweep over 41 theme and site checkouts.
- **Two defects found and fixed, both the 23.3 signature** - a generated number
  contradicting its own provenance comment. The roll-up collapsed to one broad
  `**` rule whenever more than three image directories sat at depth 1, putting
  117-pixel icons and 6600-pixel photographs under one ceiling (4 of the 41
  checkouts); and `bumpRule` fell through to a ladder with zero violations,
  producing `maxWidth: 4000` on a corpus whose widest image is 2800.
- **With both fixed the generated configs are worth keeping.** `chinburg` gets
  four rules that each describe their group; `portfolio` gets a width limit its
  own comment supports. The sweep produces no collapse anywhere and at most
  four rules in any repository.
- Still true, and confirmed rather than retired: a generated config describes
  the repository, not an intention. `init` produces a file worth editing, not a
  policy.

Still open, in rough order:

1. **Review page defaults.** Side by side scales `before` and `after` to their
   own cells, so a 2399x938 original renders half again as wide as its 1598x625
   output and cannot be compared to it honestly; wide images letterbox badly in
   a fixed-height cell. Overlay fixes both and is one click away. Also still
   unseen: narrow widths (the CSS stacks the pair, never verified in a browser -
   Chrome refused the window resize) and whether 200 cards stay navigable.
2. **Messy real-world inputs**: camera JPEGs with orientation and EXIF,
   Photoshop exports with ICC profiles, CMYK, 16-bit PNGs, animated WebP.
3. **macOS and Windows**: case-insensitive path semantics, the two-step
   case-only rename and its recovery, directory fsync tolerance, opener.
4. **Does the skill change agent behaviour?** Install
   `skills/rasterwright/SKILL.md` and compare an agent with and without it.
5. **Publishing** is the human's call: `private: true`, 0.1.0, no remote.
