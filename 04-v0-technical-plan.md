# Rasterwright v0: Technical Plan

**Status:** Implementation plan for v0. Not yet implemented.
**Date:** 2026-08-31
**Scope source:** `03-personal-project-scope.md`

> Goal: **rapid usefulness, not architectural perfection.**
> Every decision below is optimized for "I can use this on a real project in a couple of weekends," subject to the hard constraints of determinism, idempotence, and never damaging an image.

---

## 1. Preferred prototype stack

### Recommendation

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js 20+ (LTS)** | Already installed everywhere I work. Zero setup friction. |
| Language | **TypeScript** | The data model is the architecture here. Types keep the policy/plan/result pipeline honest. Compile with `tsc`, no bundler. |
| Image engine | **Sharp** | The obvious choice. Streaming, fast, well documented, actively maintained, and it exposes everything v0 needs. |
| Pixel backend | **libvips** (via Sharp's prebuilt binaries) | Comes with Sharp. No system dependency to install. |
| CLI framework | **commander** | Boring, ubiquitous, stable, does subcommands and flags and nothing else. (`cac` is a fine substitute; do not use anything with plugins or a DI container.) |
| Config | **yaml** package | Parses `.rasterwright.yml`. Validate by hand or with a small `zod` schema. |
| Globbing | **fast-glob** for discovery, **picomatch** for rule matching | Discovery and matching are different jobs; picomatch is what fast-glob uses internally anyway. |
| Review output | **Plain generated HTML + CSS + a little vanilla JS** | No React, no build step, no dependencies at runtime. One `index.html` plus copied image files. |
| Tests | **vitest** | Fast, TS-native, good fixture ergonomics. |

Dependency budget: roughly six runtime dependencies. If a seventh is proposed, it needs a reason.

### Why not the native static binary the adversarial review demanded

`02-adversarial-review.md` argued for a single static binary (Rust or Go over libvips), because "if the tool requires Node, it is competing with `npx sharp-cli` on its own turf."

That is a **distribution** argument, made for a product trying to win adoption in repos that may not have Node. It is a good argument for that goal. It is the wrong constraint for this project right now:

| | Node + Sharp | Static binary (Rust/Go + libvips) |
|---|---|---|
| Time to first useful version | Days | Weeks, most of it spent on libvips FFI and cross-compilation |
| Install for me and my team | `npm i -D rasterwright`, already have Node | `curl`/`brew`, need to build and host releases |
| Install in a repo without Node | Awkward | Trivial |
| CI without `npm install` | Not possible | Trivial |
| Image ecosystem maturity | Sharp is the most-used image API in existence | Bindings are thinner, byte-budget work is hand-rolled either way |
| My iteration speed | High | Low |

The projects I would use this on all have `package.json`. The failure mode I care about is "I never finish it," not "someone without Node cannot install it."

**Decision:** Node + TypeScript + Sharp for v0. Treat the static binary as a **future distribution optimization**, and keep the door open cheaply:

- Keep all image work behind an `operations/` layer so the engine is swappable in principle.
- Do not depend on Node-specific runtime tricks in the core logic.
- If distribution ever matters, the cheap intermediate steps are Node SEA or `bun build --compile`, not a rewrite.

### Explicitly not now

Rust, Go, Electron, Tauri, React, Svelte, a web server, a database, or any cloud infrastructure. None of them make the tool useful sooner, and several make it never ship.

---

## 2. Proposed project structure

```
src/
  cli/            # commander wiring, arg parsing, exit codes, human output formatting
    index.ts
    check.ts
    fix.ts
    init.ts
    review.ts
    render/       # table + json renderers (no Sharp, no fs writes to images)
  config/         # load + validate .rasterwright.yml, resolve rules for a path
    load.ts
    schema.ts
    resolve.ts
  scanner/        # find candidate files, read ImageInfo via sharp metadata/stats
    discover.ts
    inspect.ts
  policy/         # pure: given ImageInfo + Rule -> Violation[]
    evaluate.ts
    rules/        # one small module per check (dimensions, bytes, format, ...)
  operations/     # the only place that calls sharp to write pixels
    plan.ts       # Violation[] -> PlannedOperation[]
    execute.ts    # PlannedOperation[] -> FixResult (temp file + atomic rename)
    encode.ts     # per-format encoding, incl. byte-budget quality search
  review/         # manifest read/write + HTML generation + browser open
    manifest.ts
    html.ts
    assets/       # template css/js, inlined at generation time
  utils/          # bytes parsing, hashing, fs helpers, concurrency, logging

tests/
  unit/
  integration/
fixtures/
  images/         # small committed test images
  projects/       # tiny fake repos with .rasterwright.yml for end-to-end tests
```

Rules for keeping it simple:

- No `core/`, no `services/`, no `lib/`, no dependency injection, no plugin registry.
- Only `operations/` and `review/` may write to disk. Only `operations/` may write image bytes.
- `policy/` is pure functions over plain data. That makes it trivially testable and is where most of the logic actually lives.

---

## 3. Internal data model

The architectural principle:

```
policy -> analysis -> operation plan -> execution -> verification
```

Each arrow is a pure-ish transformation over plain data. **The CLI never calls Sharp.** It calls the pipeline and renders the result. This is what keeps `check` provably read-only and makes `--json` free.

```ts
// What we learned by looking at the file. Never mutated.
interface ImageInfo {
  path: string;              // repo-relative, POSIX separators
  bytes: number;
  format: 'jpeg' | 'png' | 'webp' | 'unknown';
  width: number;
  height: number;
  hasAlpha: boolean;         // an alpha channel exists
  isOpaque: boolean;         // ...but every pixel is fully opaque (sharp stats)
  colorSpace: string;        // 'srgb' | 'cmyk' | 'p3' | ...
  hasIccProfile: boolean;
  hasExif: boolean;
  hasXmp: boolean;
  orientation: number;       // EXIF orientation, 1 = normal
  isAnimated: boolean;
  contentHash: string;       // sha256 of file bytes
}

// The whole config file, normalized.
interface Policy {
  version: 1;
  defaults: RuleBody;
  rules: Rule[];             // ordered as written in the file
  ignore: string[];
}

interface Rule {
  glob: string;
  body: RuleBody;
}

interface RuleBody {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;         // normalized to bytes at load time
  format?: 'jpeg' | 'png' | 'webp';
  allowedFormats?: string[];
  upscale?: boolean;         // default false
  stripMetadata?: boolean;   // default true
  colorSpace?: 'srgb';
  quality?: { start: number; floor: number };
}

// Produced by policy/, consumed by everything.
interface Violation {
  path: string;
  rule: string;              // the glob that produced it
  check: 'maxWidth' | 'maxHeight' | 'maxBytes' | 'format'
       | 'metadata' | 'colorSpace' | 'orientation' | 'transparency';
  actual: string | number;
  allowed: string | number;
  fixable: boolean;
  message: string;
}

// One deterministic step. Order matters and is fixed (see section 5).
type PlannedOperation =
  | { op: 'autoOrient' }
  | { op: 'resize'; width: number; height?: number; fit: 'inside' }
  | { op: 'toColorSpace'; space: 'srgb' }
  | { op: 'stripMetadata' }
  | { op: 'encode'; format: 'jpeg' | 'png' | 'webp';
      maxBytes?: number; quality?: number };

interface FixResult {
  path: string;
  outputPath: string;        // differs when format conversion renames the file
  status: 'unchanged' | 'fixed' | 'failed' | 'skipped';
  reason?: string;           // why failed or skipped, in plain language
  applied: PlannedOperation[];
  before: Pick<ImageInfo, 'bytes' | 'width' | 'height' | 'format'>;
  after?: Pick<ImageInfo, 'bytes' | 'width' | 'height' | 'format'>;
  savingsPct?: number;
  warnings: string[];        // "could not reach byte budget", "alpha dropped", ...
  needsAttention: boolean;   // sorts it to the top of the review page
}

// What review/ persists and reads back.
interface ReviewEntry extends FixResult {
  beforeAsset: string;       // relative path to the copied original
  afterAsset: string;        // relative path to the live file
  runId: string;
  timestamp: string;
}
```

Consequences of this shape:

- `check` = discover -> inspect -> resolve rules -> evaluate -> render. It touches no writer.
- `fix` = check's pipeline, plus plan -> execute -> re-inspect -> verify.
- `--json` is `JSON.stringify` of data the pipeline already produced, not a second code path.
- Sharp appears in exactly two files: `scanner/inspect.ts` (read) and `operations/` (write).

---

## 4. Idempotence strategy

This is the most important section in the document.

### The rule

> **`fix` makes non-compliant files compliant. A compliant file gets an empty plan. Therefore the second run changes nothing.**

Idempotence is not a feature bolted on top; it falls out of defining `fix` in terms of `check`. Concretely:

1. Inspect the file as it exists right now.
2. Evaluate it against the policy. This is exactly the same code `check` runs.
3. Zero violations -> `status: 'unchanged'`, no bytes written, no temp file created.
4. Otherwise plan operations, execute, then **re-inspect the output and re-evaluate it**. If the output still violates, that is a bug or an impossible policy, and it is reported as such rather than swallowed.

Step 4 is the verification half of `policy -> analysis -> plan -> execution -> verification`, and it is what turns "we believe this is idempotent" into "the second run provably has nothing to do."

### Comparing state against policy is enough. No hidden metadata.

**Decision: v0 writes no provenance markers into image files.** Not an EXIF comment, not an XMP block, not a PNG text chunk.

Reasons:

- It directly contradicts `stripMetadata: true`, which is a default.
- It changes the bytes of an otherwise-untouched image, which is exactly the surprise this tool exists to avoid.
- It makes output depend on tool version in a way that breaks reproducibility across upgrades.
- It is not needed. Compliance is a **property of the file**, checkable in milliseconds from `sharp().metadata()` plus `fs.stat()`. There is nothing to remember.

The general principle: **the file's own state is the source of truth.** That is the same reason Prettier does not need a marker to know a file is already formatted.

### Preconditions that must hold for this to work

These are the real risks, and each needs a test:

1. **Every fix operation must produce a compliant output.** A resize that lands one pixel over `maxWidth` because of rounding makes `fix` run forever. Round down, always, and verify.
2. **Encoding must be deterministic.** Same input bytes + same operation plan + same libvips/Sharp version = same output bytes. Pin Sharp with an exact version. Record the Sharp and libvips versions in the review manifest so a surprising diff after an upgrade is explainable.
3. **The output must still match the rule that governed the input.** This is the sharp edge. Convert `hero.png` to `hero.webp` under the glob `assets/**/*.{jpg,jpeg,png}` and the output no longer matches any rule, so it silently leaves policy. Mitigations:
   - `init` always generates globs that include the target format (`{jpg,jpeg,png,webp}`).
   - `check` warns when a rule has `format: X` but the glob cannot match `.X`.
4. **Format conversion renames the file.** `hero.png` becomes `hero.webp`; the original is removed. Keeping both would mean the `.png` violates forever and gets re-converted on every run, producing an identical `.webp` each time. That is technically idempotent in bytes and clearly wrong in behavior. So: conversion replaces. Renames are listed prominently in `check --dry-run`, in `fix` output, and at the top of the review page, because **code references will break** and only the user can fix those. (v0 does not attempt to rewrite references. That is a much larger feature.)
5. **A file that cannot be made compliant must not be retried destructively.** It is left untouched and reported. The second run reports the same thing. Zero changes, so idempotence holds, at the cost of repeating the work.

### The optional cache (an optimization, never correctness)

`.rasterwright/cache.json`, git-ignored, mapping `contentHash -> { compliant | unfixable, policyHash }`:

- Lets a repeat `check` on 2,000 images skip re-decoding.
- Lets `fix` skip re-attempting a file it already proved impossible.
- Invalidated by any change to content hash or policy hash.
- **Deleting it must never change behavior, only speed.** There is a test for that.

Do not build this until a real run is slow enough to be annoying.

---

## 5. Operation ordering

Order is fixed and documented, because a different order gives different bytes and would break determinism:

1. **autoOrient** (apply the EXIF orientation flag, then clear it). First, because it changes width/height and everything downstream depends on them.
2. **resize** (down only; `fit: 'inside'`, `withoutEnlargement: true`). Second, because encoding a smaller image is both faster and the primary lever on filesize.
3. **toColorSpace** (`srgb`). Before encoding, after geometry.
4. **encode** (format + quality search). Metadata handling is part of the encode call: Sharp strips metadata by default, and `keepMetadata()`/`keepIccProfile()` opt back in. So "strip metadata" is an encoder setting, not a separate pass.

Never re-encode more than once per file per run. The quality search happens **in memory**, over buffers; only the winning buffer is written to disk.

---

## 6. Target filesize behavior

Given `maxBytes: 400kb`:

```
1. If dimensions violate policy, resize first. Often this alone solves the budget.
2. Choose the output format from policy (see transparency rules in section 7).
3. Encode to a Buffer at the starting quality (default 82).
4. If buffer.length <= maxBytes: accept. Done.
   (Do not search upward. Never spend quality budget we were not asked for,
    and never make a compliant file larger.)
5. Otherwise binary-search integer quality over [floor, start - 1]:
     - keep the highest quality whose encoded size fits
     - ~6 iterations for a range of 40 to 82
     - encoding is cheap in libvips; this is fine for hundreds of images
6. If even `floor` does not fit, apply secondary levers in this fixed order,
   only when the policy opts in:
     a. `allowExtraDownscale: true` -> step width down 90%, 80%, 70% of the
        policy max, retrying the quality search at each step, never below
        `minWidth` if one is set.
     b. format fallback, if policy allows more than one output format
        (for example PNG -> WebP when the source has alpha).
7. If nothing satisfies both constraints: FAIL EXPLICITLY.
     - do not write the file
     - leave the original untouched
     - report: "hero.jpg: cannot reach 400kb at 2400px without dropping below
       quality 40 (best: 512kb @ q40)"
     - mark `needsAttention` so it sorts to the top of the review page
     - non-zero exit code
```

Default quality band: `start: 82`, `floor: 40`, both overridable per rule. The floor exists so the tool never silently ships a smeared image to satisfy a number. **Explicit failure over surprising degradation** is the governing principle.

### Per-format differences (these are not interchangeable)

**JPEG.** The clean case. Quality 1 to 100 maps monotonically enough to filesize for a binary search to behave. Use `mozjpeg: true` for meaningfully better ratios, and pin it, since toggling it later changes every output byte. No alpha, ever (see section 7). Use `progressive: true` for web assets.

**WebP.** Also searches cleanly. Supports alpha, so it is the natural conversion target for PNGs. Note `alphaQuality` is a separate knob from `quality`; keep it at the default (100) in v0 rather than adding a second search dimension. `effort` (0 to 6) trades encode time for size; fix it at the default 4 and leave it out of the search so results stay deterministic and fast.

**PNG. Do not pretend PNG can hit an arbitrary byte budget.** PNG is lossless; there is no quality dial. The only levers are:

- `compressionLevel` and `effort` (a few percent, no quality loss)
- palette quantization (`palette: true`, `colours: N`, `dither`), which is lossy in a visibly different way from JPEG or WebP quality loss, and which wrecks photographs and gradients

v0 behavior for a PNG over budget:

1. Try lossless re-encode at max effort. If that fits, accept.
2. If the policy allows converting to WebP, convert and search there. This is almost always the right answer for a photographic PNG.
3. If the policy pins the format to PNG and lossless is not enough: **fail explicitly.** Report "PNG is lossless; cannot reach 400kb at 2400px. Options: allow WebP, raise the budget, or lower maxWidth."

Palette quantization is deliberately **not** in v0. It is a real tool for flat graphics and icons, and it is exactly the kind of operation that silently ruins an image when applied to the wrong one.

---

## 7. Transparency rules

Conservative by default. The failure mode here is a black or white box where a logo used to be, and it is the single most damaging thing an image tool can do quietly.

1. **Detect alpha honestly.** `metadata.hasAlpha` says a channel exists. `stats().isOpaque` says whether any pixel actually uses it. Both matter: a PNG with a fully opaque alpha channel has no transparency to preserve.
2. **Never flatten by accident.** No operation in v0 composites a background under an image unless the policy explicitly says `flatten: { background: '#ffffff' }`.
3. **Never convert an image with real transparency to JPEG.** If a rule says `format: jpeg` and the file has meaningful alpha, `fix` **skips the file** and reports:
   `logo.png: has transparency, JPEG cannot represent it. Set format: webp, or add flatten: { background: ... } to convert deliberately.`
   Skipping and complaining is correct. Guessing a background color is not.
4. **WebP preserves alpha.** PNG-with-alpha to WebP is the default safe conversion, and it is usually a large size win.
5. **Do not strip an opaque alpha channel as a standalone change.** It saves a few percent and produces a diff on a file the user considered fine. If the file is being converted anyway, dropping a provably-opaque alpha channel is fine and should be noted in the report.
6. **Animated images are skipped in v0** (`isAnimated: true` -> skip with a reason). Animated WebP handling is a separate problem and is not in scope.
7. **When uncertain, skip and report.** A skipped file with a clear explanation is a good outcome. A silently damaged file is not.

---

## 8. Safety

### `check`

**Never modifies files. Ever.** Enforced structurally: the check code path imports nothing that writes. There is an integration test that snapshots mtime, size, and content hash of an entire fixture project before and after `check` and asserts nothing moved.

### `fix`: originals, backups, and git

**Decision: `fix` overwrites tracked files in place and relies on git as the undo mechanism.** No `.bak` files, no `originals/` directory, no versioned copies.

Rationale: this tool is explicitly for images committed to a repository. Git already stores the previous bytes, already shows the diff, and already provides `git checkout -- .`. A parallel backup system would be a second, worse version control system, and it would leave junk in the tree.

The safety net is a precondition check instead:

- **In a git repo:** overwrite freely. Warn (do not block) if target images have uncommitted changes, since those changes are the one thing git cannot restore.
- **Not in a git repo:** refuse to run `fix` unless the user passes `--no-git` (accept the risk) or `--backup-dir <path>` (copy originals there first). This makes the dangerous case explicit rather than assumed.
- `--dry-run` on `fix` prints the full plan and writes nothing. It should be the flag people reach for first, so it is mentioned in the help text before the real thing.

Note that `review` keeps a copy of every original it touched (section 9), so there is a de facto recovery path for the most recent run regardless.

### Atomic writes

Every write is temp file plus rename:

1. Encode fully into a Buffer in memory. Nothing is written until the whole output exists and has been verified against policy.
2. Write to `<dir>/.rasterwright-tmp-<pid>-<rand><ext>` in the **same directory**, so the rename stays on one filesystem and is therefore atomic.
3. `fsync` the temp file.
4. `rename()` over the destination. On a format conversion, rename to the new path, then `unlink` the old one, in that order, so a crash between the two leaves both files rather than neither.
5. Preserve file mode. Do not preserve mtime; a changed file should look changed.

A reader (a dev server, a build) never observes a partially written image.

### Failure handling

- **Per file, not per batch.** A file either fully succeeds or is left exactly as it was. There is no partial state to roll back, so there is no rollback machinery.
- Corrupt or undecodable files are caught, reported as `status: 'failed'` with the decoder's message, and skipped. The batch continues.
- The run exits non-zero if any file failed, with a summary: `142 checked, 37 fixed, 3 skipped, 1 failed`.
- Failures and skips both appear at the top of the review page.

### Ctrl+C

- `SIGINT` sets a stop flag. In-flight encodes are allowed to finish or are abandoned before their rename; either way no partial file exists on disk.
- All temp files created by this process are unlinked in the handler.
- Prints what completed: `interrupted after 61 of 142 files; 18 fixed`.
- Exits non-zero.
- On startup, any stale `.rasterwright-tmp-*` in target directories is cleaned up (they can only come from a hard kill).
- Concurrency is capped (default `min(4, cpus)`), which also keeps the interrupt window small. Idempotence means resuming is just running the command again.

---

## 9. Review implementation

### Shape

```
rasterwright review
```

reads a manifest and writes:

```
.rasterwright/
  review/
    index.html          # self-contained page (inlined CSS + JS)
    manifest.json       # ReviewEntry[]
    before/             # copies of originals, named <hash>.<ext>
```

then opens `index.html` with the platform opener (`open` / `xdg-open` / `start`). `--no-open` prints the path instead.

`init` adds `.rasterwright/` to `.gitignore`.

### How "before" images are retained

Four options were considered:

| Approach | Verdict |
|---|---|
| **Copy originals during `fix`** | **Chosen.** Works for untracked and new files, works outside git, works for repeated runs, needs no git dependency, and costs one file copy. |
| Git HEAD as the before source | Rejected as the primary mechanism. Fails for untracked files, for staged-but-uncommitted states, and outside a repo, and it requires shelling out to git. Good as a later `review --from HEAD` mode. |
| Temporary cache discarded after `fix` | Rejected. The whole point is to look at the result *after* the run finishes, possibly after the terminal is gone. |
| Manifest of metrics only, no pixels | Rejected. Numbers without pixels is what the itch already complains about. |

Mechanics: `operations/execute.ts` copies the original into `.rasterwright/review/before/<contentHash>.<ext>` immediately before the atomic rename, and appends a `ReviewEntry`. Content-hash naming means an unchanged file is never copied twice.

Retention: keep the **last run** by default; `review --keep <n>` retains more; `review --clean` deletes everything. A run is identified by `runId`. Simple, predictable, no growth surprise.

`review` with no manifest (that is, `fix` has not been run) prints a clear message rather than an empty page.

### The page itself

Plain HTML, one file, inline `<style>` and `<script>`, images referenced by relative path (not data URIs; that would produce a 200 MB HTML file).

Layout:

1. **Header:** run timestamp, files changed, total bytes before/after, total savings, tool + Sharp + libvips versions.
2. **Needs attention, first:** failures, skips, unmet byte budgets, transparency decisions, renamed files, and anything with a suspicious savings ratio. If this section is empty, say so explicitly ("nothing needs review"), which is itself useful information.
3. **All changes:** a card per image with before/after side by side, dimensions, bytes, format, savings percentage, and the ordered list of operations applied.
4. A small amount of vanilla JS: a swipe/overlay toggle and a zoom-to-actual-pixels click. Nothing else. No framework, no build.

Design constraint: it must be readable on a laptop screen without scrolling past 200 identical "saved 61%" cards to find the one broken image. Exceptions first is the whole design.

---

## 10. Testing strategy

Fixture-based, with real image files committed to `fixtures/images/` (keep them small; a 200x200 JPEG proves the same things a 4000x3000 one does, except where dimensions are the point).

### Required test cases

| Case | Asserts |
|---|---|
| resize | Output width equals `maxWidth` exactly, aspect ratio preserved, never one pixel over |
| format conversion | PNG to WebP produces a valid WebP, original removed, rename reported |
| transparent PNG | Alpha survives PNG to WebP; PNG to JPEG is **skipped with a reason**, not flattened |
| opaque-alpha PNG | `isOpaque` detected; alpha not stripped as a standalone change |
| orientation | EXIF orientation 6 is applied, dimensions swap, orientation flag cleared, no double-rotation on a second run |
| max bytes (JPEG) | Output is under budget, quality landed above the floor, search converged |
| max bytes (WebP) | Same |
| max bytes (PNG, impossible) | **Fails explicitly** with a useful message; file untouched |
| no upscale | A 400px source under a `maxWidth: 2400` rule is untouched, not enlarged |
| already-compliant image | Zero violations, zero writes, `status: 'unchanged'` |
| **idempotent second run** | See below. The regression test that matters most |
| corrupt file | Reported as failed, batch continues, original untouched |
| impossible policy | `maxWidth: 100` + `maxBytes: 10` + `format: png`: fails cleanly, no partial file |
| batch with partial failure | 5 files, 1 corrupt: 4 fixed, 1 failed, exit non-zero, the 4 are correct |
| `check` is read-only | mtime + size + hash of every fixture file unchanged after `check` |
| glob precedence | Overlapping rules resolve per the documented precedence |
| byte-unit parsing | `500kb`, `500KB`, `512000`, `0.5mb` all parse to the documented value |
| cache is optional | Deleting `.rasterwright/cache.json` changes nothing but runtime |
| interrupt | Simulated abort leaves no temp files and no partial images |

### The idempotence regression test (explicit)

```
1. Copy fixtures/projects/mixed into a temp dir.
2. Run fix. Record every file's content hash.
3. Run check. Assert exit code 0 (no remaining violations).
4. Run fix again.
5. Assert: every content hash is identical to step 2,
           every FixResult.status is 'unchanged',
           zero bytes were written (spy on the fs writer),
           zero temp files were created.
```

Run this over a fixture project that includes at least: an oversized JPEG, a transparent PNG converted to WebP, an EXIF-rotated photo, an already-compliant file, and a file that cannot meet its budget. Step 5's "zero bytes written" assertion is stronger than comparing hashes, because it catches the case where the tool re-encodes to an identical result and merely looks idempotent while doing wasted, non-deterministic-in-principle work.

---

## 11. Vertical-slice milestone

The first end-to-end target. Everything else is negotiable; this is not.

On a real project directory:

1. Parse `.rasterwright.yml`, including `defaults` and two globs.
2. Scan the repo for image files, respecting ignores.
3. Inspect each file's metadata (dimensions, format, bytes, alpha, orientation, color space).
4. `rasterwright check` prints violations in a readable table and exits non-zero.
5. `rasterwright fix` handles `maxWidth` + `maxBytes` + conversion to WebP.
6. Transparency is preserved through the conversion.
7. `rasterwright check` runs again and **passes**.
8. `rasterwright fix` runs again and **modifies zero files**.
9. `rasterwright review` generates a before/after HTML page and opens it.

When steps 1 through 9 work on one of my actual projects, the tool goes into real use, and everything after that is driven by what annoys me during real use rather than by this document.

Deliberately **not** in the vertical slice: `init` heuristics (hand-write the first config), `--json`, colorspace normalization, the cache, pre-commit and CI integration, and `SKILL.md`. All of them come after the loop closes.

---

## 12. Deferred technical decisions

Not decided, not designed, not prototyped. Revisit only when a concrete need appears.

- Native or static single binary (Rust, Go, Node SEA, `bun build --compile`)
- Any Rust or Go rewrite
- Desktop UI of any kind
- A database or persistent index
- Cloud backend, hosted review, shared history
- GitHub App or GitHub Action
- MCP server
- AI provider integration of any kind
- Semantic image analysis: saliency, face detection, smart crop
- Perceptual quality metrics (SSIMULACRA2, DSSIM, Butteraugli) as a quality floor. Genuinely valuable, and the right eventual replacement for a fixed numeric quality floor. Not v0.
- AVIF encoding and decoding
- SVG handling (optimization, rasterization for review)
- Animated image handling
- Responsive variant / srcset generation
- Rewriting code references after a format conversion renames a file
- Palette quantization for PNG
- Parallelism beyond a simple concurrency cap
- Windows-specific path and opener handling beyond what Node provides
- A labeled before/after contact sheet PNG for agent vision (cheap to add later, and worth adding if agents start reviewing runs)

---

## 13. Recommended build order

Short, ordered, and not a full backlog. Each step should end with something runnable.

1. **Skeleton and types.** `package.json`, TypeScript config, vitest, commander wiring for four subcommands that print "not implemented." Define the data model from section 3 first; it is the contract everything else is written against.
2. **Config loading.** Parse and validate `.rasterwright.yml`, normalize byte units, resolve which rule applies to a path. Pure functions, fully unit tested. Decide and document glob precedence here.
3. **Scanner and inspector.** Discover files, read `ImageInfo` via Sharp. Read-only. This is the first point where something real happens: `rasterwright check --json` can dump what it found.
4. **Policy evaluation and `check`.** Pure `ImageInfo + Rule -> Violation[]`, plus the human table and exit codes. **Ship this.** A read-only `check` is already useful on its own and carries zero risk of damaging a file.
5. **Fixture corpus.** Build `fixtures/images/` and `fixtures/projects/` before writing any code that writes pixels. Every subsequent step is tested against them.
6. **Operations: plan and execute, without byte budgets.** Auto-orient, resize, strip metadata, format conversion, with the temp-file-plus-atomic-rename writer and per-file failure isolation. Add the idempotence test at this point, before it is hard to retrofit.
7. **Byte-budget encoding.** The quality search, the floor, per-format differences, explicit failure. This is the trickiest logic in the project and it belongs behind an already-tested execution layer.
8. **Transparency handling.** Detection, safe conversion, skip-and-report for the JPEG case. Could be folded into step 6; kept separate here because it deserves its own tests.
9. **Review.** Manifest, before-copies during `fix`, HTML generation, browser open. Closes the vertical-slice loop.
10. **`init`.** Now that the policy schema has been proven in use, write the scan heuristics and the commented starter config.
11. **Use it on a real project.** Then fix what is actually annoying, in whatever order the annoyance dictates.

Only after step 11: `--json` polish for agents, a `SKILL.md`, a pre-commit hook, and CI integration, in that order, and only if the tool has survived real use.

---

## 14. Implementation decisions from real-world `check` testing

Added 2026-09-01, after running the read-only `check` against a production
WordPress theme with 75 governed images. These supersede the corresponding
guesses earlier in this document. Nothing here is implemented yet except where
noted; the rest is binding on the future `fix`.

**1. `maxBytes` is a ceiling, not a target.** `quality.start` is the *maximum*
quality the encoder will initially try. If that output already fits the ceiling,
accept it. Search quality downward only when the ceiling is exceeded, and never
upward to consume unused budget. (Implemented in the schema and types.)

**2. Renames require per-run authorization, not config.** The permission belongs
on the command, not in `.rasterwright.yml`:

```
rasterwright fix --allow-renames
```

This covers **both** filename-changing operations:

1. a format conversion that changes the extension - `hero.jpg` -> `hero.webp`;
2. correcting an extension that disagrees with its contents, with no pixel
   change at all - `logo.png` holding WebP bytes -> `logo.webp`.

Both can break source-code references, which is the only thing that matters
here; that the second rewrites no pixels does not make it safer. Policy
describes the desired state of the assets; `--allow-renames` is execution
permission. Without the flag, `fix` **skips** the affected file and reports why.
It does not fail the batch: a file needing human approval is not a broken build.
Do not add an `allowRenames` config property.

**2a. A blocked rename skips the whole file, not just the rename.** If
`logo.png` holds WebP bytes *and* is oversized, then without `--allow-renames`
`fix` leaves it completely alone. It does not resize and re-encode a file it is
about to leave deliberately mis-named. Reasons: a file's operation plan is
applied coherently or not at all; a partial pass would spend a lossy re-encode
that the eventual authorized run has to spend again; and finishing a run having
knowingly produced a still-invalid file is worse than finishing having skipped
it with a reason.

**2b. Re-encoding an already-lossy image is allowed when a hard violation
demands it.** A WebP under `format: webp` that exceeds `maxBytes` may be
re-encoded in place - no rename, so no permission needed. Constraints:
only when an *error*-level finding requires it, never on a compliant file, and
if dimensions also violate policy, resize first and encode exactly once.
Generation loss is real, so the review output must state that a lossy re-encode
happened rather than presenting it as a free saving.

**3. `stripMetadata` is a normalization preference, not an enforcement rule.**
It means "if Rasterwright rewrites this file, drop the ancillary metadata", not
"any EXIF anywhere means the repository is broken". The real run found 3 genuine
constraint violations and 17 files carrying harmless EXIF; failing on the latter
buried the former. Metadata findings are therefore warnings and never affect the
exit code. No `enforceMetadata` option until a concrete need appears.
(Implemented.)

**3a. `fix` never rewrites a file for metadata alone.** If ancillary metadata is
the only finding, the result is `unchanged`. Metadata is stripped only as part
of a rewrite that some *error* already required - a resize, a format conversion,
a byte-budget encode, orientation normalization, or a colour-space conversion.
The consequence is that metadata warnings can persist indefinitely on files
nothing else touches, and that is the correct outcome: producing a diff on a
file nobody said was wrong is exactly the surprise this tool exists to avoid.
No `--include-warnings`, and no metadata-only rewrite path.

**3b. No `--fail-on-warnings`.** Warnings continue to exit 0. There is no
demonstrated need, and the option's existence would invite putting it in CI,
which recreates the noise problem severity was introduced to solve.

**4. An ICC profile is colour management, not disposable metadata.** It is not
counted by `stripMetadata` at all. It is used to determine colour-space status,
and an image tagged `sRGB IEC61966-2.1` under `colorSpace: srgb` is compliant
and silent. The eventual fix order is: decode source colours correctly ->
convert pixels to sRGB if required -> encode -> decide what profile to retain.
(Detection implemented; the conversion path is not.)

**5. Findings carry a severity.** `error` breaks the repository contract and
fails the run; `warning` is worth fixing and never fails it; `info` explains what
a future `fix` would do. The human report shows errors individually, summarizes
warnings, and hides notes behind `--verbose`; `--json` stays exhaustive.
(Implemented.)

**5a. Ordinary image properties are not findings.** The first real project
produced 55 notes, nearly all of them "this PNG has an alpha channel". `hasAlpha`
and `isOpaque` stay on `ImageInfo`, available in `--json` and to fix planning,
but they emit no finding on their own. They surface only where they change an
answer - today, a `format: jpeg` rule against an image with real alpha, which
reports the `format` finding as unfixable and names transparency as the reason.
`--verbose` should show what is exceptional, not catalogue what is normal.
(Implemented.)

**6. File extension versus encoded format is a first-class check.** The theme
contained a `.png` that Sharp decodes as WebP, which every content-derived check
happily passed. Extensions are load-bearing for MIME types, bundler loaders,
CDNs and caches, so a mismatch is an error. Its fix is a rename, and therefore
subject to `--allow-renames`. (Implemented.)

**7. Glob case sensitivity follows the platform**, deterministically: Windows
case-insensitive, Linux and macOS case-sensitive. No filesystem probing. macOS
is usually case-insensitive on disk but not always, and matching should not
depend on which volume a repository happens to live on; case-sensitive also
agrees with CI. (Implemented.)

**8. `check` never encodes.** No trial encodes, no `--verify-budgets`. `check`
inspects and evaluates; `fix` transforms. `maxBytes` fixability stays `unknown`
because the honest answer requires an encoder.

**9. Deferred, with the reasoning recorded.** A `preferredFormat` distinct from
a hard `format` requirement; a `--strict` mode that promotes unknown colour
space to an error; caching or lazy analysis for `stats()` cost. None of these
were justified by the real run. Revisit when a project demonstrates the need.

---

## 15. Refinements from implementing `fix --dry-run`

Added 2026-09-01, after building the pure planner and running it against the
same WordPress theme. These refine sections 3, 5 and 14; they do not replace
them. Execution is still unimplemented.

**1. `PlannedOperation` gained a `rename` step and lost `stripMetadata`.** The
sketch in section 3 had a standalone `stripMetadata` operation and no way to
express a filename change. Metadata handling is an *encoder setting* (section 5
already said so), so representing it as its own operation implied a second
rewrite that never happens; it is now a boolean on `encode`. `rename` is a real
step, emitted last, and it carries `reencode: false` for the case that matters -
correcting an extension without touching pixels.

`encode` also carries what the report has to be honest about:
`budgetDriven` (is the byte ceiling the *reason* for this encode, or a limit
that also applies?), `lossyReencode` (generation loss is happening),
`preserveAlpha`, and `outcomeRequiresVerification` (planning did not encode, so
the resulting size is unknown and execution must measure it).

**2. Planning is per file, and produces a file-level status.** Findings are not
planned independently and concatenated. One file gets one coherent plan with a
status of `unchanged`, `planned`, `requires-permission`, `unfixable` or
`unsupported`. `unsupported` exists so an animated image is reported as out of
scope rather than being resized into a single frame - the animation check has to
come *before* fixability, because a resize is "fixable" in the abstract.

**3. Resize floors both dimensions.** Section 4's precondition 1 said round
down; concretely, `to.width` and `to.height` are both `Math.floor(dimension *
ratio)` where the ratio is the tightest of `maxWidth/width`, `maxHeight/height`
and 1. Rounding to nearest can land a pixel over a limit, which would make the
second `fix` run find the same violation.

**4. A resize implies an encode.** Pixels cannot be resized in place, so any
geometry, orientation or colour-space change plans exactly one `encode`
afterwards, and the byte ceiling applies to that encode even when the file was
already under it. The report distinguishes `target` (the budget is why we are
encoding) from `ceiling` (a limit that also applies), and both require
verification, because re-encoding at `quality.start` a file that was originally
encoded at a lower quality can legitimately grow it.

**5. An extension mismatch is not always a rename.** `logo.png` holding WebP
bytes under `format: png` is re-encoded to real PNG and keeps its name: the
policy resolves the mismatch in the other direction. The rename is planned only
when the *target format* disagrees with the current extension, which also means
`photo.jpeg` is never renamed to `photo.jpg` for tidiness.

**6. Dry-run exit codes mirror `check`'s.** `0` when every error is covered by a
plan this run could execute, `1` when any file is left unresolved (blocked,
unfixable, unsupported), `2` for configuration or runtime failure. Warnings
never affect it. `fix --dry-run` exiting 0 therefore means "Rasterwright has a
complete plan", which is the thing worth gating automation on.

**7. Plain `fix` fails rather than aliasing `--dry-run`.** Until an executor
exists, `rasterwright fix` prints that execution is not implemented and exits 2.
Silently making the dangerous command safe would teach the habit of typing the
dangerous command, and that habit outlives the safety.

**8. Blocked plans are still reported.** A `requires-permission` file carries
`blockedOperations` - the plan permission would unlock - while `operations` stays
empty. Nothing executes from `blockedOperations`; it exists so granting
`--allow-renames` is a decision rather than a leap.

**9. Rename collisions are a batch preflight, not a planner concern.**
`planFile()` stays pure and file-local: it cannot see the filesystem, and it
cannot see the other files in the run, so it can detect neither of the two ways
a rename collides. Pushing that into the renderer would put correctness logic in
a formatter. Execution gets a preflight step instead:

```
FilePlan[] + existing repository paths
    -> validatePlanSet(...)
    -> executable / collision / blocked
```

It must eventually catch two files targeting the same output path, a rename
target already occupied by an existing file, case-collisions where the platform
makes them possible, and any other path-level conflict a single-file planner
cannot see. `fix --dry-run` should eventually consume the same results, because
a plan that cannot execute safely is not a complete plan and should not be
reported as one. Not implemented; the dry-run planner today reports a plan that
preflight may later reject.

**10. `colorSpace: srgb` is a promise about the output, not just the pixels.**
Execution interprets the source profile correctly, converts pixels to sRGB when
required, encodes, and then **embeds an sRGB profile** so the result is
explicitly tagged. An untagged output is sRGB only by convention, and the point
of the policy is to stop relying on that convention.

This means `stripMetadata: true` must never remove the guarantee `colorSpace:
srgb` created. It covers ancillary, non-colour metadata - EXIF, XMP, IPTC,
Photoshop tags, text chunks - and nothing else. (Section 14.4 already said an
ICC profile is colour management rather than disposable baggage; this is the
output-side half of it.)

Where no colour-space policy applies, execution is conservative: it keeps a
meaningful source profile rather than silently discarding it. Discarding a
profile changes how every pixel is interpreted, which is not a normalization.

**11. No source-quality inference.** Rasterwright does not try to detect the
quality a JPEG or WebP was originally encoded at. The signals are indirect,
per-encoder, and wrong often enough that acting on them would be a heuristic
sitting underneath every output byte. When a hard error forces a lossy image to
be rewritten, execution uses the configured `quality.start`, states that a lossy
re-encode happened, and - when a ceiling exists - verifies the result against
it. A compliant file is still never re-encoded, so the case where this would
cost the most does not arise.

The invariant this protects: **one required rewrite produces one final encode.**
Not resize-then-encode, then re-encode to normalize, then re-encode again to
convert format. Every required transform is folded into the single output
encode. (This is why the planner emits exactly one `encode` per file.)

**12. A PNG that may not fit is uncertain, not unfixable.** The planner is right
to plan the encode with `outcomeRequiresVerification: true` rather than giving
up: whether a lossless re-encode fits is an empirical question, and refusing to
try would be as dishonest as promising success. Execution resolves it:

1. attempt the allowed lossless optimization;
2. measure the result;
3. under `maxBytes` - accept it;
4. over `maxBytes`, with no format escape or further downscale the policy
   permits - **fail explicitly**: leave the original byte-for-byte untouched,
   report the best size actually achieved and why it was not enough, mark the
   file failed, and exit non-zero.

There is no best-effort degraded PNG, and no palette quantization. The general
shape, which is not specific to PNG:

```
planning   outcome uncertain
execution  attempt, then verify
failure    original untouched, reported
```

## 16. Decisions from implementing batch plan preflight

Added 2026-09-01, immediately after section 15. This builds 15.9 and supersedes
its "not implemented" note; it does not change anything else.

**1. `blocked` is a sixth `FilePlan` status, not a flag on `planned`.** A plan
that preflight refused is not a plan this run could execute, and every consumer
that asks "can this run" - `complete`, the exit code, the summary counts, the
report sections - has to get the same answer. Modelling it as a status means
none of them can forget to check a boolean. Its shape mirrors
`requires-permission` exactly: `operations: []`, the refused plan preserved in
`blockedOperations`, `resolves: []`, `unresolved` holding what it would have
cleared, and `reasons` carrying a sentence that names the colliding path.
`requiredPermissions` is untouched, because a collision is not a permission
problem and rerunning with a flag will not fix it.

`validatePlanSet(plans, existingPaths, semantics)` lives in
`operations/plan-set.ts`, is pure, imports no `node:fs`, mutates nothing, and
returns plans in input order. It is the only part of planning that sees more
than one file, and it is testable entirely with string arrays.

**2. Only a `planned` plan claims a path or can be blocked.** A
`requires-permission` file has a `targetPath` but is not going to write to it,
so it cannot collide with anything, and neither can `unchanged`, `unfixable` or
`unsupported`. An in-place `planned` rewrite claims its own path, which is what
makes "rename onto a file another plan is rewriting" a `duplicate-target`
rather than something that slips through.

**3. Conservative refusal, always, including chains.** Two plans claiming one
target block both - there is no defensible way to pick a winner, and writing one
of them leaves the run in a state neither plan described. A rename onto an
existing path blocks, even when the occupant is another plan's source that would
move away first (`A.png -> A.webp` while `A.webp -> A.jpg`). Ordering those two
renames would work right up until the run is interrupted between them, and then
a file is gone with no record of where it went. Rasterwright does not sequence
renames. A refused batch costs one rerun after a rename; a lost image is
permanent.

**4. darwin and win32 fold case for collisions, even though glob matching does
not.** Section 14 fixed glob matching as case-sensitive on macOS and Linux
(Windows matching stays case-insensitive) so a report is reproducible across
machines. Collision detection goes the other way:
on macOS and Windows, `Hero.webp` and `hero.webp` are one file, so both are
compared folded and a case-only collision blocks. The asymmetry is deliberate
and the two cases are not the same kind of mistake - matching the wrong file is
a reporting bug, and overwriting the wrong file is data loss. Folding on a
case-sensitive volume that happens to be mounted on macOS only ever refuses a
batch that would have worked, which is the safe direction to be wrong in.
`caseOnly` on each conflict records that the collision needed folding, so the
message can say so.

**5. Existing paths come from the scan plus one `lstat` per uncovered target.**
Discovery already walked the tree, so every image file in the project is known
for free; `RunCheckResult` exposes it as `discovered`. It is deliberately *not*
on `CheckReport` - it is not a finding, and `check --json` is a published shape
that must not move. The scan is not sufficient on its own, because a rename
target need not be an image: a directory, a symlink, a git-ignored file or a
`.txt` all occupy the name. So every planned rename target the scan did not
already cover gets one `fs.lstatSync(abs, { throwIfNoEntry: false })`. `lstat`
rather than `stat`, so a dangling symlink counts as occupied - resolving the
link would report the name as free and then clobber the link itself.

That probe is the only filesystem access planning adds beyond `check`. It opens
nothing, and `fix --dry-run` remains read-only under the same snapshot tests.

**6. Preflight feeds `complete`, so exit codes stay meaningful.** `blocked` is
added to `FixPlanSummary` and joins `requiresPermission`, `unfixable` and
`unsupported` in the `complete` calculation, so `fix --dry-run` exiting 0 keeps
meaning "this whole batch could be executed" rather than "each file looked fine
on its own". The full conflict list is exposed as `conflicts` on the JSON
report; the human report gets a `BLOCKED` section after `REQUIRES PERMISSION`.

**7. A failed probe is not a free path.** `throwIfNoEntry: false` turns the
one answer that frees a path - "nothing is there" - into `undefined`. Every
other errno still throws, and none of them mean free: `EACCES` on an unreadable
parent directory, `ENOTDIR`, `ELOOP`, `ENAMETOOLONG` when swapping the
extension pushes the filename past the filesystem's limit. Each blocks its plan
under a `target-unreadable` conflict that names the errno, and adds a stderr
diagnostic. Nothing escapes as a stack trace.

Under case-insensitive semantics a successful probe is followed by a read-only
`readdir` of the parent directory, so the spelling recorded is the one the disk
actually holds. `lstat('a/LOGO.WEBP')` succeeds against a stored `a/logo.webp`,
and recording the requested spelling would report a case-only collision as an
exact one. If the `readdir` fails the requested spelling is used and the path is
still treated as occupied; only the wording suffers.

**8. Four conflict kinds, and a plan may carry several.** `duplicate-target`
and `target-exists` are the two from 15.9. `source-claimed` is the far end of a
refused chain: its own target is free, but another plan would rename onto its
current path, so its conflict names *that* path rather than its output.
`target-unreadable` is the failed probe above. A two-cycle (`a.png -> b.webp`
while `b.webp -> a.png`) genuinely collides in two ways from each end, so
conflicts are deduplicated by `(path, kind, with)` rather than collapsed to one
per file.

Conflict messages name each competing plan with its *own* target path, because
under folding those spellings differ and printing the blocked plan's spelling
would send the reader to a file that does not exist. An in-place rewrite is
described as one rather than as a second rename.

**9. Case folding is `toLowerCase()` and nothing more.** No Unicode NFC/NFD
normalization. Both sides of every comparison originate in the same directory
listing, so a path stored as NFD is compared against a target derived from that
same NFD string and the byte sequences already agree. Normalizing would
introduce a transformation neither the filesystem nor the config performed, and
HFS+ and APFS do not agree with each other about which form to store.

**10. A blocked plan clears everything that only happens while executing.**
`operations`, `resolves`, `requiresVerification` and `normalizedDuringRewrite`
are all emptied, exactly as `planFile()` does for `requires-permission`. Both
execute nothing, so neither may claim an encode to verify or a warning swept up
along the way. `blockedOperations` keeps the refused plan so the collision is
legible, and `requiredPermissions` is untouched - a collision is not a
permission problem and rerunning with a flag will not fix it.

**11. `ruleGlobExcludesTargetFormat` considers every glob, not the matched
ones.** Found while checking the note preflight repeats. A policy of
`"assets/*.png": {format: webp}` plus `"assets/*.webp": {...}` converts
`hero.png` into a file the second rule governs, but that rule never matched
`hero.png`, so answering from `matchedGlobs` claimed the file was leaving
policy. `RuleContext` gained `allGlobs`; `evaluate()` takes it as an optional
third argument defaulting to the matched globs, which is the honest answer for
a caller that knows nothing else.

**12. Granting `--allow-renames` can surface new conflicts.** A file waiting on
permission has no rename, so it has nothing to collide with. The first run that
grants the flag is therefore the first run that can see the collision, and the
report says so explicitly rather than letting it read as a regression. This is
also why `BLOCKED` sits directly after `REQUIRES PERMISSION`: it is the section
that appears when the previous one is granted.

## 17. Decisions from building the execution foundation

Added 2026-09-01, after section 16. This phase landed the pieces execution is
made of - the Sharp pipeline, the atomic writer, the git survey - with unit
tests and **no wiring**. Plain `rasterwright fix` still exits 2, and `check` and
`fix --dry-run` remain read-only under the same snapshot tests. Only one shipped
behaviour changed, and it is a planner fix: item 1 below.

**1. `autoOrient: false` needs the orientation flag preserved through a rewrite
it did not ask for.** This was a live bug, not a hypothetical. `checkOrientation`
returns no finding under `autoOrient: false`, so `planFile()` emits no
`autoOrient` operation. If any *other* error forces a rewrite of that same file -
a `maxWidth` violation, say - Sharp's default metadata stripping clears the flag
while leaving the pixels unrotated, and the image starts displaying rotated. A
600x400 file that displayed as 400x600 would display as 600x400.

The fix is `preservesOrientation` on `EncodeOperation`, set when
`image.orientation !== 1` and no `autoOrient` operation is planned. Execution
writes the flag back with `withExif({ IFD0: { Orientation: '<n>' } })`, which was
chosen over the two alternatives on measurement:

| call | flag | ICC written | EXIF written |
|---|---|---|---|
| `withExif({IFD0:{Orientation}})` | kept | none | minimal block |
| `withMetadata({ orientation })` | kept | 480 B sRGB profile | yes |
| `keepExif()` | kept | none | the source's entire block |

**What that call actually does is not what it looks like.** Sharp ignores the
orientation *value* passed to `withExif` and fills it in from the source:
passing `'1'` against a source flagged 6 still yields 6, and so does
`withExif({IFD0:{Software:'x'}})`. What preserves the flag is that `withExif` is
called at all, which makes the encode one that writes an EXIF block. The value
is written as the source's own orientation anyway, because a call that reads as
an assignment Sharp overrules is a trap for the next person. The property the
tests assert is the one that actually holds: the output flag equals the input
flag, for orientations 3, 6 and 8 alike.

`withMetadata()` is never used as a generic "keep": embedding an sRGB profile as
a side effect contradicts both `stripMetadata: true` and the keep-the-source
profile branch below.

**The consequence is stated in the plan rather than discovered later.** A file
that had no EXIF now has a minimal block, so the next `check` reports a metadata
warning. Warnings never justify a rewrite, so the second run still writes zero
files and idempotence holds. But the dry run has to say so or it is no longer an
honest description of the run, so the plan carries a note and the human report
carries an `orientation` line on the encode.

`stripMetadata: false` needs none of this: `keepMetadata()` already carries the
flag through, and calling `withExif()` on top of it would replace the whole EXIF
block the policy asked to keep.

**2. The planner speaks in displayed dimensions; the encoder resizes stored
pixels.** Those agree except in exactly one case: a quarter-turn orientation
(5 to 8) that is being preserved rather than applied. There the stored image is
the displayed one with its axes swapped, and handing the resizer the displayed
target would fit the long stored edge into the short limit. A 400x600 displayed
image under `maxWidth: 300` would come out 133x200 instead of 300x450. The
pipeline swaps the target for that case and only that case.

**3. `fit: 'inside'` can land under the planned dimensions, and that is
correct.** The planner floors width and height independently from one ratio, so
the pair it names is not always exactly the source's aspect ratio; Sharp honours
the tighter constraint and preserves the aspect ratio exactly. `tall.png`
(200x1400) under `maxHeight: 600` is planned as 85x600 and comes out 85x595.
Under is compliant and stays compliant. Over would make the next run resize
again, which is the direction that breaks idempotence, and it cannot happen.

**4. Colour handling is three-way, and the difference is invisible in the tags.**
Verified by reading stored pixel values back with `{ ignoreIcc: true }`, because
reading them *without* it re-applies the ICC import and makes a correctly tagged
non-sRGB output look identical to an sRGB one.

| plan | call | stored pixels | embedded tag |
|---|---|---|---|
| has `toColorSpace` | `withIccProfile('srgb')` | converted to sRGB | sRGB, 480 B |
| none, source has an ICC | `keepIccProfile()` | left in the source space | the source's |
| none, no ICC | nothing | sRGB | untagged |

All three are colour-correct. `toColourspace('srgb')` is never called: it changes
libvips' interpretation of the numbers rather than performing the ICC transform,
and it is not needed anyway, because a plain encode of a CMYK JPEG already
emerges as sRGB.

**5. Budget-driven plans are skipped, not attempted.** *Superseded by section
19.* This held only while the quality search did not exist. `budgetDriven` still
marks the plans where a byte ceiling is the *reason* for the encode, and it
still decides whether the report says "target" or "ceiling", but it no longer
decides anything about execution: `renderCandidate()` searches, and
`verifyCandidate` decides whether the result may be written. `skipReasonFor`'s
budget branch and the pipeline's `budgetDriven` throw are both gone.

**6. A case-only self-rename is performed in two steps, and only where it is
needed.** `a.JPG` to `a.jpg` is one file on macOS and Windows, so a direct
rename is a no-op and the extension is never corrected. `commitRename()` goes
through an interim name for exactly that case: a case-only difference under
case-insensitive path semantics. Everywhere else the plain rename is correct,
and taking the two-step route anyway would put the user's only copy under an
interim name for no reason at all.

**During that window the interim file is the only copy of the image**, which
makes its name a safety property rather than a detail. It is
`<target>.rasterwright-moving-<pid>-<rand>`: visible, not a dotfile, named after
where it was going, and deliberately *not* `.rasterwright-tmp-*`. Nothing ever
unlinks one. It is not registered with `TempRegistry` (which now refuses to
accept anything that is not a temp file), the stale sweep skips it, and
`recoverInterruptedMoves()` puts it back under its intended name on the next
run. Where that name is already occupied the file is left exactly as it is and
reported as needing attention, because the one thing worse than an oddly named
image is a deleted one. If the second rename fails, the first is undone and the
error names all three paths.

The earlier draft of this got it wrong in a way worth recording: it reused the
temp prefix and registered the interim file, so a Ctrl+C or a hard kill plus one
later run would have deleted the user's only copy. Two mechanisms whose whole
purpose is "delete this, it is disposable" were pointed at the one file that was
not. This closes the known limitation recorded in `05`.

**7. Before-copies are deferred to the review phase.** This phase's whole claim
is that nothing partial is ever left on disk, and a second write surface brings
its own partial states: orphaned copies after a SIGINT, a half-written manifest,
retention policy, `.gitignore` handling, and a `.rasterwright/` directory the
read-only snapshot tests currently prove never appears. Each is a way for the
safety proof to fail for reasons unrelated to the safety layer. The cost of
waiting is low: the executor holds the original bytes in a Buffer already, so
adding the copy later is one insertion at a call site that will be marked as
such. `runId` and `engine` are on `FixReport` now so the manifest has something
to key on when it arrives.

**8. The git survey answers `unknown`, never "clean", when it cannot answer.**
`rev-parse --show-toplevel` detects the repository, because the config can sit
below the work tree root. One `status --porcelain -z --no-renames
--untracked-files=all` call per 1000 pathspecs classifies every path as clean,
modified (staged counts as modified, because it is still uncommitted) or
untracked. `--untracked-files=all` matters: without it an untracked file inside
an untracked directory is reported as the directory, and the file about to be
overwritten is never named. Status output is relative to the work tree root while
pathspecs are relative to the working directory, so the prefix is stripped back
off. A git that cannot be run gives `state: 'unknown'`; a git that runs and
refuses gives `not-a-repo`, which is a real answer rather than a failure to get
one.

Untracked files are warned about separately from modified ones. Section 8 only
named uncommitted modifications, but an untracked image has no git history at
all, so overwriting it is strictly less recoverable. The remedies differ too:
commit or stash for a modified file, `git add` or `--backup-dir` for an untracked
one.

**9. Two env-gated hooks exist, for properties only observable from outside the
process.** "The second run writes zero bytes" cannot be proved by comparing
hashes, and the integration tests spawn a real CLI child process, so no stub can
be injected. `RASTERWRIGHT_TRACE_WRITES=<path>` appends one line per mutating
filesystem step (`temp-write`, `rename`, `unlink`), so an empty trace file is the
assertion. `RASTERWRIGHT_ABORT_AFTER=temp-write` calls `process.abort()` between
the fsync and the rename, which is the one moment residue is possible. Both are
inert unless set, are documented in `atomic.ts` as test-only, and are read from
the environment per call so a normal run behaves exactly as if they did not
exist.

**10. The candidate is verified as a buffer, never as a temp file.**
`inspectBuffer()` was extracted from `inspect()` for this: it yields a full
`ImageInfo` from bytes that have never touched disk. Verifying a temp file
instead would mean a crash mid-verification leaves a file on disk that nothing
has yet vouched for. It also means the candidate is measured by exactly the same
inspector the read path uses, rather than by a parallel implementation that can
drift.

**11. `runFixPlan` was split so execution and the dry run share one preflight.**
`planRun(config, version, options)` returns `{ plans, conflicts, check,
diagnostics, permissions }`; `runFixPlan` builds the dry-run report from it. The
alternative was duplicating `surveyTargets`, which is where all the `lstat`
conservatism about occupied paths lives, and an executor running against a plan
set a different preflight approved is not the plan the dry run described.

**12. A 16-bit source is `unsupported`, not resized.** Sharp's encoders write 8
bits per channel, so a 16-bit PNG through any encode comes back `uchar` with no
warning and half its precision gone. Honouring a `maxWidth` at that price is not
a fix. `ImageInfo` gained `bitDepth` (from libvips' band format, `ushort` being
the one that matters), `check --json` reports it, and `planFile()` returns
`unsupported` with `"<n>-bit source; v0 encodes 8-bit only"` whenever a plan
would encode one. A rename-only plan touches no pixels, so an extension
correction on a 16-bit file is still performed.

**13. The pipeline repeats two of the planner's refusals.** `renderCandidate()`
throws on a 16-bit source and on a JPEG encode of an image with meaningful
alpha, checking the *image* rather than trusting `preserveAlpha`. Both are
already impossible by construction, and both are unrecoverable if they ever
happen: flattened transparency and discarded precision cannot be undone from the
output. The check sits on the far side of the planner boundary, so the planner
changing is not enough to reach it.

**14. Never rename onto a path that already exists.** Every rename that creates
a *new* name lstats the destination immediately beforehand and refuses if
anything is there, `convertAndReplace` included. Batch preflight already answers
the same question across the whole plan set, so this is the last line of defence
rather than the first, and it exists because the two answers are separated by
however long the run takes. A residual TOCTOU window remains between the lstat
and the rename: `rename(2)` has no portable fail-if-exists mode
(`RENAME_NOREPLACE` is Linux-only and Node does not expose it), the window is
microseconds, and the alternative is a link-then-unlink dance that is not atomic
either.

**15. The directory entry is fsynced after every rename.** A rename is atomic
with respect to readers, but the entry can still be in the page cache when the
power goes out, so the file's contents survive and its name does not. Failures
are tolerated: some platforms refuse to open a directory for reading, and
failing a rename that already succeeded would be worse than the risk.

**16. The stale sweep skips temp files whose owning process is alive.** The pid
is in the name, so `process.kill(pid, 0)` answers it (`EPERM` counts as alive).
Without this, two concurrent runs over one project would delete each other's
in-flight temp files and turn safe writes into failed ones.

**17. The git survey reports ignored files, and distinguishes "no" from "I
cannot tell".** `--ignored=matching` adds a fourth classification: git has no
history for an ignored image either, so overwriting one is as irreversible as
overwriting an untracked one, and the remedy differs again (`git add -f`, not
`git add`). `--literal-pathspecs` stops git reading `star[1].png` as a character
class and reporting the file as clean. Only `fatal: not a git repository` means
`not-a-repo`; every other refusal, including a root git could not enter, is
`unknown` with git's own message attached, because `fix` refuses outside a
repository and proceeds inside one, so a confident wrong answer sends the whole
run down the wrong path. A path git reports that cannot be mapped back to
something the caller asked about makes the survey `unknown` rather than being
dropped, since dropping it would report that file as clean.

**18. Recorded, not implemented.** Three things this phase found and
deliberately left alone.

*Indexed PNG sources grow.* `png({ palette: false })` writes truecolour, so a
palette PNG that goes through any rewrite can come out roughly three times its
original size. `palette: true` is not the answer on its own: it is only lossless
while the colour count is unchanged, and a resize interpolates new colours, so
it would quietly become a lossy path. This is the byte-budget phase's decision,
and it will probably want a palette flag on `ImageInfo` to make it.

*A truncated JPEG passes inspection.* `sharp().metadata()` reads the header and
does not decode, so a file whose pixel data is cut short inspects cleanly and
gets a plan. `sharp(source, { failOn: 'error' })` in the pipeline is the
backstop: the decode throws during `toBuffer()`. 2b must catch that and report
the file as `failed` with the decoder's message, leaving the original alone,
exactly as it does for a file that fails to open.

*The pre-rename existence check has a residual TOCTOU window.* See item 14.

---

## 18. Decisions from wiring `fix` execution

Added 2026-09-01, after section 17. This phase wired the 2a foundation into a
working `rasterwright fix`. `check` and `fix --dry-run` are unchanged and still
write nothing; the read-only snapshot tests cover the refusal paths of the real
command as well now, because a run that refuses must genuinely have changed
nothing.

**1. The rename-only carve-out.** A candidate this run *encoded* is committed
only when evaluating it produces no error-level finding at all. That default is
not weakened anywhere. The one exception is a `planned` plan whose operations
are exactly one `rename` with `reencode: false`: nothing was produced, so there
is nothing that could have been produced badly, and the bytes landing under the
new name are byte-for-byte the bytes already on disk under the old one.

Three checks stay blocking even there - `decode`, `extension` and `format` -
because they are the only ones the rename itself can be wrong about. Everything
else (`maxWidth`, `maxHeight`, `maxBytes`, `colorSpace`, `orientation`)
describes pixels the rename did not touch and which were already in that state
before the run started. Those findings are reported on the result as
`warnings`, set `needsAttention`, and exit 1.

The case that forces the decision is `fixtures/projects/depth`.
`assets/deep-named.jpg` is a 16-bit PNG behind a `.jpg` extension, and its plan
is a rename and nothing else. After the rename it lands under `assets/*.png`,
whose `maxWidth: 800` it breaks - and any plan that would encode it is
`unsupported` for its bit depth (17.12). Under a strict rule the outcome is a
permanent, unfixable failure: the rename is refused on every invocation, the
extension stays wrong forever, and there is no flag or config change that
resolves it. Under the carve-out the file is moved to the name policy demands,
the width violation is reported as still outstanding, and the repository is
strictly closer to its policy than it was.

The better long-term home for this is the planner: `planFile()` could evaluate
the post-rename state against the target rule and return `unfixable`, so the
dry run reports the dead end instead of the executor discovering it. That is a
planner change with its own fixture and snapshot churn and was out of this
phase's scope. The carve-out is the right behaviour until it exists.

**2. Preconditions run before any write, including the startup sweep.** The
order inside `runFix` is: validate `--backup-dir`, plan, the git precondition,
recover interrupted renames, sweep stale temps, install the signal handlers,
execute. The sweep only removes dead-pid `.rasterwright-tmp-*` files, but it is
still a write, and a run that refuses outside a repository having already
modified the tree would make the refusal a lie. Recovery runs before the sweep
because an image under an interim name must be put back before anything
observes its intended name as free; the two touch disjoint filename patterns
anyway.

Both passes are scoped to the parent directories of the files this run could
write, never the whole tree, and both report through stderr and
`report.diagnostics` rather than being counted silently.

**3. `FixReport.unrecovered`.** `recoverInterruptedMoves()` returns a list of
interim files it could not put back because the intended name is occupied. Each
one is a user image sitting under a name nothing else recognises, which is the
most important thing a run can say, so it is a first-class field rather than a
diagnostic string - and a non-empty list exits 1 regardless of how every file
fared.

**4. An undecodable file is `failed`, not `skipped`.** `planFile()` returns
`unfixable` for a file `check` could not decode, and the status table would
otherwise map that to `skipped` alongside the files merely waiting on a flag.
Section 8 says corrupt files are reported as failed, and it is right: a broken
file is not a policy Rasterwright declined to apply. `statusForSkip()` splits
the two on whether `plan.unresolved` contains `decode`.

**5. A missed byte ceiling gets its own message.** A non-budget-driven encode
can still come out over `maxBytes` - `mixed` puts `maxBytes: 200kb` on its broad
rule, so every encode there carries `outcomeRequiresVerification`. The raw
`maxBytes` finding says the file is too big, which reads as a bug when the user
just asked Rasterwright to make it smaller. The failure says what actually
happened instead. *The last clause is superseded by section 19*: the message no
longer says the search does not exist. It names where the search stopped, the
smallest output it reached, and the manual remedies - or, when the policy's
floor equals its start, the single quality that was tried and why there was no
band to search.

**6. Exit codes.** 0 when nothing needs attention and the run was not
interrupted; 1 when any result needs attention, an image is stranded, or the run
was interrupted; 2 for a configuration failure, a refused precondition, or an
unexpected throw. An interrupt is 1 rather than 130 so the whole tool speaks in
three codes and a caller never has to special-case a signal number. A refused
precondition is 2 rather than 1 because nothing was attempted, which is the
shape of a configuration failure and not of a run that found problems.

**7. The git precondition surveys once, and warns per file only inside a
repository.** One `surveyGit` call over the source paths of the plans that would
actually write. In a repository, each modified, untracked or ignored target gets
its own warning naming the remedy that works for its case. Outside one - or when
git could not answer - the run refuses unless `--no-git` or `--backup-dir`, and
when it proceeds anyway it says so once for the whole run rather than repeating
"git could not tell" per file. Same information, one line.

**8. `--backup-dir` refuses to overlap the project, and refuses to overwrite a
differing backup.** A directory under the project root would be walked by the
next `discover()`, governed by the project's own globs, and swept for stale
temps; the reverse nesting is refused too, because a backup directory containing
the project makes "which of these is the real tree" a question. Copies mirror
the repo-relative path rather than being flattened, since two `logo.png` files
in different directories would otherwise collide and the second would silently
win. An existing backup of identical bytes is accepted, so a rerun after a
partial run works; one holding different bytes fails that file, because it may
be the only surviving original. That is the simpler of the two safe options -
the alternative was `<name>.<hash>` - and it never destroys anything.

**9. `RASTERWRIGHT_STALL_MS`, a third test-only hook.** It waits inside
`writeTemp` at the same instant `RASTERWRIGHT_ABORT_AFTER=temp-write` aborts,
which is the one moment a temp file exists and the rename has not happened. It
exists so the SIGINT test can deliver its signal at a deterministic edge rather
than guessing at wall-clock timing. Same discipline as the other two: read from
the environment per call, inert unless set, documented as test-only.

**10. The dry run lost one line.** `"Executing a plan is not implemented yet."`
was removed from the plan summary, because it is no longer true. Nothing else
about `fix --dry-run`'s output or behaviour changed.

**11. Before-copies are still deferred (17.7).** The call site in
`executeFile()` is marked with a comment, immediately after the backup and
before the write, where the original bytes are already in hand. `review` is
where it lands.

**12. The plan is checked against the file it described, immediately before the
write.** `check` hashes every file it reads, so comparing that hash with the
bytes the executor re-reads costs one comparison and closes a real window: a run
over a large project takes long enough for somebody to save an image in an
editor while it is in flight. Rendering the new bytes through the old plan would
apply a resize computed for different dimensions and overwrite that edit with
it. The file is `failed` with "the file changed on disk after this run planned
it", and rerunning picks up the new contents. The check sits immediately after
the read, so it covers rename-only plans too - those never reach the pipeline,
and their target extension was derived from the old bytes just the same.

**13. `executeFile` cannot throw.** Every failure path already returned a
`failed` result, but a throw from anywhere else - a resolver, an inspector, an
unexpected libvips state - would reject inside `mapWithConcurrency`, take down
the whole worker pool, and turn one bad file into an aborted batch exiting 2.
The body is wrapped, so per-file failure isolation is a property of the code
rather than of having enumerated every failure correctly.

**14. Only the plans that will execute count as writes.** The git survey and the
sweep/recovery directory set are built from plans where `skipReasonFor()` returns
undefined, not from every `planned` plan. A file skipped for its byte budget is
never opened, so warning that git has no copy of it describes a risk that does
not exist, and sweeping its directory is a write nothing asked for.

**15. `--backup-dir` validates eagerly and creates lazily.** The overlap refusal
and the not-a-directory refusal are pure checks; the directory itself is created
by the first copy that needs one. Otherwise a run refused for a later reason - or
one that turns out to have nothing to write - leaves an empty directory behind,
and "Rasterwright refused and changed nothing" has to be true everywhere it is
claimed.

**16. Residue that cannot be cleaned up is reported, not forgotten.**
`TempRegistry.cleanup()` keeps any path it failed to unlink, so `paths()`
afterwards is exactly the list of temp files this process left behind, and
`runFix` turns each into a diagnostic. The discard on a failed write does the
same inline, naming the leftover in the failure message. The sweep's own message
is neutral about how residue got there - a dead pid says the run ended, not how.

**17. `--json` produces a document on an exit 2.** A caller that asked for JSON
and got an empty stdout has to special-case it, and the most likely way to
handle that badly is to read "no output" as "no findings". Both commands catch
their own failures and emit `{rasterwrightVersion, error, exitCode}` on stdout
with the human message on stderr. Deliberately not a report with zero files,
which would be a lie in exactly the situation where being believed matters.

**18. Commander's failures exit through Rasterwright's codes.** Positional
arguments are rejected (`allowExcessArguments(false)`) rather than accepted and
ignored, `--concurrency` is matched as a whole integer rather than handed to
`parseInt` (which reads `1.5` as 1), and `exitOverride()` routes commander's own
usage errors to exit 2 instead of its default 1. A script gating on the exit code
could otherwise not tell a typo in the command line from a repository full of
oversized images.

## 19. Decisions from implementing byte-budget execution

**1. The search lives in `pipeline.ts`, not in a new `encode.ts`.** Section 2
sketches `encode.ts` as the home for "per-format encoding, incl. byte-budget
quality search", and that sketch predates the pipeline. Everything the search
needs is already inside `renderCandidate`: the built Sharp chain, the 16-bit
refusal, the alpha/JPEG refusal, the three-way colour decision, and
`resizeTarget`'s stored-versus-displayed dimension swap. Splitting the encoder
out would mean either passing a half-built `Sharp` across a module boundary or
duplicating the chain construction. The chain is built once by `buildChain()`
and only the encoder is re-run.

**2. The algorithm.** Encode at `quality.start`. If those bytes fit, accept them
and stop: one encode, `searched: false`. Otherwise binary-search the integer
qualities in `[floor, start - 1]`, keeping the highest whose *measured* size
fits. Never below the floor, never upward from `start`, never a second lever.
When nothing fits, the smallest probe measured is returned with the quality that
produced it. A PNG has no dial, so it is re-encoded losslessly at maximum effort
exactly once and either fits or does not.

**3. Monotonicity is not assumed, and the cost of that is named.** Only a probe
whose own bytes were measured under the ceiling is ever accepted, and the
highest such probe is kept rather than the one the binary-search invariant would
imply. **The search can never write bytes over the ceiling.** What it *can* do
on a non-monotone curve is miss a fitting quality, and in the worst case that
means reporting a failure where a fitting quality existed - if quality 70 is the
only one that fits, the search probes 60, finds it over, and abandons the half
that contains 70. Both shapes are pinned by tests.

Measured over 20,000 synthetic curves built from a decreasing trend plus noise
(19,948 of them non-monotone): 314 missed a higher fitting quality, none
produced a false failure, and none produced an over-ceiling result. The false
failure needs an isolated fitting island rather than trending noise, which is
why it needs a constructed test rather than a fuzz to demonstrate. Empirically
the real risk is lower still: all 43 qualities from 82 down to 40 on
`fixtures/images/overbudget.jpg`, the hardest case in the corpus, contain zero
inversions.

The alternative is a linear scan of the whole band on every over-budget file,
which is 43 decodes instead of 6 to remove a failure mode nobody has hit. The
binary search stays, and the honesty about what it costs stays with it.

**4. `attempts <= 8` is an invariant, not a cap.** The widest band the schema
allows is 1 to 100, which is 99 values, needing seven probes plus the initial
one. A cap that stopped the search early would make the chosen quality depend on
the width of the band, which would break the determinism claim outright. It is
asserted in tests instead.

**5. The pipeline decides nothing.** `verifyCandidate` remains the sole
authority on whether bytes may be written: a search that could not reach the
ceiling hands its best attempt back anyway, verification produces the `maxBytes`
error-level finding, and the write is refused there like every other refusal.
The search outcome only feeds the failure message. This is why the phase needed
no new refusal logic.

**6. A single Sharp instance is safe to reuse sequentially, and is cloned
anyway.** Mutating `.jpeg({quality})` on one instance and calling `.toBuffer()`
repeatedly produces byte-identical output to cloning before each encoder call,
verified against this repo's sharp: q82, q40 and q82 again all reproduce
exactly. Never share an instance across *concurrent* `toBuffer()` calls, because
the options object is mutated in place. `.clone()` costs nothing measurable and
keeps the base chain obviously immutable, so the loop clones.

**7. Probe cost, measured.** libvips re-decodes the source buffer on every
`toBuffer()`, which is the real cost of the search and is accepted for v0. On
`overbudget.jpg` (700x700 incompressible noise) a six-probe search takes about
1.1 seconds, roughly 185 ms per probe. Typical photographic content is faster,
and a file already under its ceiling costs one encode as before.

There is a memory cost too, and it is not free: sharp's `clone()` runs
`structuredClone` over its options, which for buffer input **copies the whole
source buffer**. Measured against `overbudget.jpg`, twenty live clones add 9,141
KB of `arrayBuffers`, exactly 457 KB each. The search holds one clone at a time,
so peak memory is bounded, but every probe allocates and discards a full copy of
the source and the churn scales as probes x source size x concurrency. Mutating
a single instance instead would avoid it and produces byte-identical output
(item 6), so this is a deliberate trade of allocation for a chain that cannot be
accidentally shared. Revisit it if a large-image run shows GC pressure. Do *not*
optimize by decoding once to raw pixels and encoding from that: it would change
the ICC handling path, which operates on the decoded chain, and risks different
output bytes. That trades the determinism guarantee for a speedup nobody asked
for.

**8. `allowExtraDownscale` and format fallback are deferred.** Section 6 sketches
a fallback ladder whose later rungs step the dimensions down and then try another
format. Neither key exists in the schema, and neither is built here.

- They are new *policy* surface wearing an execution phase's clothes. Each needs
  a schema key, validation, a place in the glob-merge precedence rules, an
  `EffectiveRule.sources` attribution so a violation can name the rule that set
  it, documentation, and config tests.
- Format fallback is a rename, so it collides with `--allow-renames`, with batch
  preflight, with the `ruleGlobExcludesTargetFormat` check and with the
  one-encode-per-file invariant. Worse, it would make the output format depend on
  an encoding result, so `fix --dry-run` could no longer state the target path.
  That contradicts the planner's purity, which the whole dry run rests on.
- Extra downscale changes what `maxWidth` means. Today it is a limit and the
  resize target is derived from it deterministically; stepping to 90 or 80
  percent makes the output dimensions a function of encoder results, and two
  runs could disagree about whether a file is compliant.

Instead, the failure messages name both as the *manual* remedies the user can
apply right now: raise `maxBytes`, lower `maxWidth` or `maxHeight`, or allow
WebP for that glob. Saying that in the failure is most of the value at none of
the cost, and it keeps the promise that an explicit failure explains what to do
next. The suggestion is per format, because offering WebP to a WebP file is
noise.

**9. No palette quantization, and no palette flag yet.** Section 17.18 asked
this phase to decide whether an indexed PNG needs a flag on `ImageInfo`. The flag
itself is trivial - `sharp().metadata()` exposes `isPalette` - but the *condition*
is not. libvips routes `palette: true` through imagequant whatever the input, and
quantization is lossless only while the target colour count is at least the
source's actual colour count, which nothing in the metadata reports. Verifying
pixel identity at runtime is possible and not expensive, but it turns a
"lossless" claim into something that depends on getting an equality check right,
which is exactly the silent-damage surface section 7 exists to avoid. So: ship
the honest PNG failure, and revisit palette support as its own phase with the
raw-pixel equality check as its correctness argument and a genuinely indexed
fixture, which the corpus does not have today.

**10. The search outcome lives on `FixResult`, never on `FilePlan`.** `FilePlan`
is the pure planner's output and `fix --dry-run` publishes that exact shape.
Writing an execution result into it would make the plan disagree with what
`planFile()` produced and would quietly break the invariant that planning
predicts nothing. `FixResult.encode` is additive and optional, so no existing
`--json` consumer breaks.

**11. Ceiling-only encodes now search too, which is a visible change.** A rule
setting `maxBytes` puts `outcomeRequiresVerification` on *every* encode it
governs, not only the ones the budget caused. Those encodes previously ran once
at `quality.start` and failed if the result came out over; now they search down
like any other. Files nobody flagged as over budget can therefore land at a lower
quality and a smaller size than they did before this phase. That is the intended
behaviour - a ceiling is a ceiling - but it is a real change in output bytes and
is recorded here rather than discovered in a diff.

**12. The plan is built against the rule governing the OUTPUT path.** This is
the one real bug the phase shipped and then fixed. `planFile()` read `maxBytes`
and `quality` from the rule matching the file's *current* path, while
`verifyCandidate` evaluates the candidate against the rule matching its *target*
path. Those agree for every plan that leaves the file where it is, and disagree
for every format conversion that moves it under a different glob. Two failure
shapes, both reachable from an ordinary config:

- A source rule with no ceiling and a target rule with one. The search never
  ran, the single encode came out over, and a perfectly reachable ceiling was
  reported as an unfixable file.
- A source rule with a tight ceiling and a target rule with a loose one. The
  search burned quality chasing a budget that stopped applying the moment the
  file moved, then reported success against a ceiling nothing checks.

The fix keeps the planner pure. `planFile(file, permissions, { ruleFor })` takes
a resolver callback, and `planRun` passes `resolver.resolve`, which is a
deterministic function of the loaded config: no filesystem, no Sharp, same
inputs and the same plan. Omitted, everything behaves exactly as before, which
is right for any plan that does not move a file.

The split of responsibilities is deliberate. The **source** rule decides what
the file must *become*: `format` (and therefore the output path), `colorSpace`,
`stripMetadata`, `autoOrient`. The **destination** rule decides what the output
must *satisfy*: `maxBytes`, and the `quality` band the search turns to meet it.
Size limits take the tighter of the two, so the output is compliant at both ends
of the move and the source's own violation is still resolved.

Three consequences worth stating:

- **A destination-only limit rides along with a rewrite; it never causes one.**
  A rename that touches no pixels stays that way. Re-encoding a file to satisfy
  a limit it is only about to inherit would spend generation loss on a filename
  change, and on a 16-bit source it would turn the one plan that works into an
  `unsupported` one, leaving the file permanently mis-named with no remedy - the
  exact outcome the rename-only carve-out in section 17 exists to prevent.
- **A target path matching no rule has no ceiling at all.** The source's number
  stopped applying when the file moved, and carrying it forward would enforce a
  rule that no longer governs the file, silently. A note says so.
- **The dry run names the glob.** When the ceiling comes from somewhere other
  than the rule the user is looking at, the plan says which glob supplied it.
  A number with no provenance reads as a bug.

---

## 20. Decisions from implementing `review`

Added 2026-09-01, after section 19. This phase closed the vertical-slice loop
from section 11: `fix` now retains a copy of every original it overwrites, and
`rasterwright review` turns those copies into a static before/after page.
`check` and `fix --dry-run` are unchanged and still create no `.rasterwright/`.

**1. A failed before-copy fails the file.** The copy sits immediately after
verification and immediately before the atomic write, one line below the
`--backup-dir` copy, and it is refused the same way: the file is failed, the
original is left byte-for-byte untouched, and the batch continues. The
precedent is the right one. Inside a repository git covers tracked, clean
files - but `fix` warns per file precisely because untracked, ignored and
modified files have no stored copy at all, and for those the before-copy is the
only pixel-level record of what the original looked like. Overwriting an image
while silently failing to keep the copy the user would judge the result by
inverts the tool's whole posture.

Two things make that livable rather than annoying. All three levels of the path
are validated once up front - `.rasterwright`, `.rasterwright/review` and
`before/` must each be absent or a real directory - so a tree that can never hold
review data refuses before anything is written rather than failing every file in
turn. And `--no-review` exists: one flag, explicit in the shell history, and the
run proceeds keeping nothing.

The check uses `lstat`, so a symlink is refused even when it points at a real
directory: Rasterwright writes copies here and later deletes unreferenced ones,
and a link makes both happen somewhere the path does not name. A *dangling*
symlink matters twice over, because `stat` reports it as absent and `mkdir` then
fails `EEXIST` - the run would fail every file with an errno instead of one
sentence naming the link. `review --clean` uses `lstat` for the same reason: it
reports honestly that it removed a link rather than claiming there was nothing
there.

**2. The manifest is written once, at the end.** Not per file. Entries are
collected in memory as `FixResult.beforeFile` and folded into one run record
after the worker pool has drained, which puts a single small write at the end of
a run instead of N concurrent read-modify-writes over one JSON file. An
interrupted run still reaches it: the stop flag makes every remaining worker
return `skipped`, the pool drains normally, and the run records what it
completed with `interrupted: true`. Only a second SIGINT, which exits from the
signal handler, skips the write - and that run's before-copies are hash-named
and unreferenced, so the next prune collects them.

Concurrency across runs is a read-merge-write window of microseconds in which
two simultaneous `fix` runs over one project could lose one run's entry. A lock
file would close it and is not worth the machinery. Documented, not pretended
away.

**3. A run that wrote nothing records nothing.** Deliberately *not* "a run with
no results". A second, idempotent `fix` over `fixtures/projects/mixed` still
reports `icons/logo.png` as skipped, and recording that as a run would prune
away the run that actually changed something and garbage-collect its
before-copies. So the test is whether the run *wrote*: at least one `fixed`
result. That keeps two guarantees true at once - a second run leaves
`.rasterwright/` byte-identical, and the page always describes the run that
produced the files currently in the working tree.

The exceptions of a run that did write are recorded alongside its written files,
with no before-copy, because the file on disk still *is* the original. They are
what the "needs attention" section is mostly made of.

**4. The manifest is written before anything is collected.** Both in `fix` and
in `review --keep`. Collecting first and then failing the write would leave a
manifest referring to before-copies that no longer exist, which turns a
recoverable bookkeeping failure into a page with missing images. In this order
the worst case is a copy nothing refers to, and the next prune removes it.

**5. Garbage collection removes only what it can prove is its own.** Two rules.
A candidate name must match `^[0-9a-f]{64}\.(jpe?g|png|webp)$`, so a `notes.txt`
or a subdirectory a human put in `before/` is never a candidate at all. And it
must be referenced by no retained run. An unlink that fails is a diagnostic, not
an error: the copy is disposable by definition. Collection runs when a run is
recorded and when the user asks via `review --keep`, and never on a `fix` that
wrote nothing.

**6. Retention is persisted, not per invocation.** `retain` lives in the
manifest and defaults to one run. `review --keep <n>` sets it, prunes to it and
rewrites. If `--keep` were a flag on `review` alone, the next `fix` would prune
straight back to one and `--keep 5` could never actually show five runs.

**7. Stale outputs are a note, never a broken image.** Each written entry
records the sha256 of the bytes the run wrote (`FixResult.after.contentHash`,
already in hand from the candidate inspection). At render time `review` stats
and hashes each output and says which of three things is true: it is what the
run produced, it has changed since, or it is gone. A page opened days later over
a working tree that has moved on then explains itself instead of showing a later
edit as though Rasterwright had produced it.

**8. Exception thresholds.** Computed by `review/classify.ts`, a pure function,
so they can change without invalidating manifests written by an earlier version.

| Flag | Condition |
|---|---|
| `failed` / `blocked` / `skipped` | the result status |
| `unresolved` | the write left error-level findings outstanding (the rename-only carve-out, 18.1) |
| `unmet-budget` | a refusal under an encode carrying `maxBytes`, or an output over one |
| `transparency` | a *refusal* whose reason names transparency |
| `renamed` | `outputPath !== path` |
| `grew` | savings below zero |
| `barely-shrank` | savings under 2% on a `lossyReencode` |
| `shrank-suspiciously` | savings over 95% |
| `quality-only-drop` | savings over 70% with no `resize` applied |
| `dimensions-without-resize` | the dimensions moved with no `resize` or `autoOrient` applied |

Two flags the scouting design proposed were dropped. `alpha-lost` is
unreachable: `verifyCandidate` already fails any encode required to preserve
transparency that did not, so a written file can never have lost it. And
`transparency` on every alpha-preserving *success* was noise - a WebP that kept
its alpha made no judgement call worth reviewing, which is the thing 03 asks the
section to surface.

**9. Needs attention holds the cards; all changes holds the rest.** Section 9
described both sections listing every image, which means a flagged written file
appears twice on one page. Instead the exceptions section renders the full card
for every flagged entry, and "all changes" renders the full card for every
written file that is not already above, with one line saying how many are. Every
file appears exactly once, and the exceptions are still first.

**10. `fix` hints about `.gitignore` and never edits it.** Once per recorded run,
`git check-ignore -q .rasterwright/`. Exit 1 means not ignored and is the only
case worth a word; exit 0, exit 128, and a git that cannot be run all mean say
nothing, which is the rule `operations/git.ts` already follows. Writing to a
file the user version-controls as a side effect of an image fix would turn up
unexplained in their next `git diff`. `init` still writes that line, on purpose.

Note that `check-ignore` rejects `--literal-pathspecs` outright and exits 128,
unlike every other git invocation in that module. The one caller passes a fixed
literal with no glob characters, so nothing is lost.

**11. `review` has no exit 1.** Zero when the page was rendered and zero when
there was nothing to render; two for a configuration or runtime failure. It is
not a gate - it reports what a previous run did, and that run already had its
say about the exit code. A project where `fix` has never run is not a project
with a problem, so "nothing to review" is a message on stderr and a clean exit.

`review --clean` removes `.rasterwright/review/` and never `.rasterwright/`
itself, which is Rasterwright's namespace in the project and may hold other
things later.

**12. The page is rendered on the server, escaped once.** No JSON blob, no
client-side templating: every card is static, escaped HTML written at generation
time. The page then works with JavaScript disabled and there is one escaping
path to audit rather than two. Paths go through `encodeURIComponent` per segment
*and* HTML escaping; both are required and they are different operations. The
script is about seventy lines and does four things: an exceptions-only filter, a
path filter, a per-card overlay slider, and click-to-zoom in a `<dialog>`.

**13. `review --json` is not implemented.** The manifest is already the
machine-readable artifact, it is stable JSON at a known path, and a second
serialization of it that drifts is worse than no serialization at all. `fix
--json` already reports `beforeFile` and `reviewRecorded` for anything that
wants to find it.

**14. `--clean` and `--keep` together are refused.** Retention says what to keep
from now on; `--clean` keeps nothing at all. Letting one silently win would make
the command's effect depend on an argument order nobody wrote down.

**15. The two panes share one scale, so a resize is visible as one.** Both boxes
are the same size on screen, so `object-fit: contain` alone draws a 300px output
exactly as large as the 700px original it came from - and the operation most
worth seeing becomes invisible. Each image is instead sized as its fraction of
the larger of the two, in percentages because the box width is a grid column
only the browser knows. Overlay mode puts both back to 100%: there the images are
being aligned pixel for pixel, not compared for size, and the zoom dialog shows
each at its natural size regardless.

The checkerboard follows the same principle of not saying false things: it is
drawn only behind a PNG or a WebP. `FixMeasurement` carries no alpha flag, so
format is the honest signal available, and behind a JPEG the checkerboard was
decoration implying a transparency that cannot exist.

**16. The overlay's clipped layer takes no pointer events.** At a full reveal the
before layer covers the after pane completely and the after image cannot be
clicked at all. The clipped layer is `pointer-events: none`, so a click in
overlay mode always reaches the after pane, and two explicit "Zoom before" /
"Zoom after" buttons in the reveal row give each pane a route of its own. The
images stay focusable throughout, so the keyboard route never depended on any of
this.

**17. The zoom dialog titles the pane it is showing.** The card carries
`data-before-name` and `data-after-name` as separate attributes rather than one
space-joined string: the after pane of a renamed file lives at a different path,
and a path can contain a space, which makes splitting a joined attribute back
apart wrong in two independent ways.

---

## 21. Decisions from implementing `init`

Added 2026-09-01, on top of a `check`, `fix` and `review` that already worked
against a real project. That order is what makes this section short: the schema
had already been proven in use, so `init` had a target to generate rather than a
format to invent.

### 21.1 Module layout

```
src/init/scan.ts        the read-only discovery and inspection pass
src/init/heuristics.ts  pure: paths + ImageInfo -> ProposedRule[]
src/init/template.ts    pure: ProposedRule[] -> the text of a config
src/init/gitignore.ts   the check-ignore probe and the append
src/run-init.ts         the pipeline. Writes nothing.
src/cli/init.ts         the only writer in the command
src/cli/render/init.ts  pure: the stderr summary
```

The `run-init` / `cli/init` split mirrors `run-check` / `cli/check` and earns
the same thing: the whole heuristic can be tested against real image corpora
without a test ever risking a write, and the integration test that asserts the
tree is untouched has something meaningful to assert about.

`scan.ts` reuses `discover` and `inspect` unchanged. Neither needs a policy:
`discover` takes a root, and the extension list lives in `SUPPORTED_EXTENSIONS`
rather than in a config. That is the whole reason a config-less command can
share the read path with a config-driven one.

### 21.2 The heuristic

**Grouping.** Directory anchors, in five steps:

1. Group by POSIX dirname. Root-level images anchor non-recursively
   (`*.{jpg,jpeg,png,webp}`); every other anchor is `<dir>/**/*.{...}`. One
   stray screenshot beside `package.json` must not produce a rule governing the
   whole tree.
2. A recursive anchor absorbs every anchor at or beneath it.
3. Anchors holding fewer than three images are dropped, unless that would leave
   none. Three files is the smallest group a percentile can say anything about.
4. While more than three anchors remain, the deepest is rolled up into its
   parent and absorption runs again. Ties in depth are broken by taking the
   lexicographically last directory, so the result is deterministic.
5. A roll-up that reaches the project root collapses to one broad
   `**/*.{...}` rule rather than producing a recursive root anchor that would
   contradict the non-recursive one from step 1.

**Numbers.** `maxWidth` is the 90th percentile of *displayed* widths (so EXIF
orientation is already applied) and `maxBytes` the 95th percentile of file
sizes, each rounded up a fixed ladder:

| Ladder | Rungs |
|---|---|
| width | 640, 800, 1000, 1200, 1600, 2000, 2400, 3000, 4000 |
| bytes | 50kb, 100kb, 150kb, 200kb, 300kb, 500kb, 750kb, 1mb, 1.5mb, 2mb, 3mb, 5mb |

Percentiles are nearest-rank (sort ascending, take index `ceil(p/100 * n) - 1`),
so every number in a provenance comment is a value that actually exists in the
repository. A value above the top rung stops at the top rung; 4000 pixels and
5mb are already generous ceilings for a web image, and the summary says how many
files a topped-out ladder flags.

Bytes get the looser percentile because an image corpus is usually bimodal: many
small icons plus a few photographs. p90 on bytes lands between the humps. On the
real theme corpus, p90/p90 at a 10% target produced a config flagging seven
files; p90/p95 at 5% produced three, which are the same three the hand-written
config flags.

**Closure.** The candidate policy is built in memory, run through
`createResolver` and the real `evaluate`, and each rule then climbs its ladder
until at most `max(3, 5%)` of the images it governs are over a limit. At most
eight steps, and it stops when both ladders top out.

Only `maxWidth`, `maxHeight` and `maxBytes` findings drive the loop. An
extension that disagrees with its contents, or a stray EXIF block, is a real
finding no ceiling can move, and reacting to one would loosen the policy for a
reason unrelated to size - and, on a corpus where every file has one, would
climb to the top rung for no reason at all.

A consequence worth writing down: because nearest-rank p95 leaves at most 5% of
a group above it and the tolerance is 5%, a freshly proposed **byte** limit is
already inside tolerance. The byte branch of the bump is reached only when the
width ladder has topped out. That is the intended shape rather than dead code -
the byte percentile is deliberately the looser of the two - but it means the
loop in practice moves `maxWidth`.

### 21.3 A generated glob has to match the files it was generated from

Three separate ways that fails, all of them silent, and all of them producing a
config that looks authoritative while governing nothing.

**Directory names are not glob-safe.** A directory really can be called
`img (old)` or `[drafts]`, and interpolating one into a pattern hands picomatch
syntax instead of a name. Every character picomatch reads as syntax
(`\ * ? [ ] { } ( ) ! + @ | ,`) is backslash-escaped before interpolation.
Escaping is unconditional rather than clever: `!` is only special leading and
`+`/`@` only before a parenthesis, but a backslash in front of any of them is
always the literal character. Only the directory is escaped; the `**` and the
extension group are syntax we wrote ourselves.

**Backslashes and YAML.** Escaping puts backslashes in the glob, and a directory
can also just be called `a\b`. Inside a double-quoted YAML scalar those are
escape sequences, so the loader would receive a different pattern than the one
generated, silently, and only for the directories least likely to be tested.
Globs are therefore emitted as single-quoted scalars with `'` doubled, where the
only special character is the quote itself.

**Case.** Discovery matches extensions case-insensitively, so `hero.JPG` is
found and measured; rule matching is case-sensitive everywhere except Windows.
A group of four lowercase spellings would therefore measure that file and then
report it as ungoverned. The extension group carries every spelling the scan
actually saw, so a corpus with `x1.JPG` in it gets `*.{jpg,jpeg,png,webp,JPG}`
and an ordinary corpus keeps the short, readable group.

The group is computed once for the whole scan rather than per anchor, so every
rule in a file ends the same way.

`globFor(anchor, group)` takes the group as a required parameter with no
default, because `anchors.map(globFor)` would otherwise pass the array index as
the group and produce nonsense. That is not hypothetical; it is what the first
version of the tests did.

### 21.4 Verification uses the real evaluator, and says so

`init` prints the exact number of errors and warnings `check` will report. It is
free once the files are inspected, and it is the only thing that stops the very
next command from being a surprise. It is exact rather than estimated because it
is the same `evaluate` over the same `ImageInfo`, plus one decode error per
*governed* unreadable file, which is precisely how `run-check` counts them.

Verified against the Bokka theme: `init` predicted 5 errors and 24 warnings, and
a real `check` against the generated config reported 5 and 24.

### 21.5 Never `format`, never `maxHeight`

A generated `format` rule renames files, needs `--allow-renames` to execute, is
unsafe over transparency, and is a policy judgement a heuristic has no standing
to make on someone's behalf. `maxHeight` is omitted for a smaller reason: it
duplicates what `maxWidth` already governs on almost every corpus, and two
limits where one will do makes the file harder to read.

Both appear as commented examples beside the numbers they would sit next to, and
the `defaults` block is written out explicitly with the built-in values, so the
generated file teaches what exists rather than hiding it.

### 21.6 The text is validated before it is written, not after

`loadConfigFile` was split into `parseConfigText(text, label)` plus a read.
`init` validates through that exact function before touching the filesystem. The
alternative - write, then load, then apologise - leaves a config the loader
rejects sitting in the user's repository, and a second parallel validator would
drift from the thing it validates.

### 21.7 `.gitignore`: append, and let git decide

Section 9 already assigned the job to `init`. Three conditions, all required:
the command is `init`; `git rev-parse --is-inside-work-tree` succeeds; and
`git check-ignore -q .rasterwright/` says it is *not* already ignored.

Delegating to `check-ignore` rather than searching the file for a string gets
nested `.gitignore` files, negations, `.git/info/exclude` and global excludes
right for free, and makes a second `init` a no-op for the right reason. An
answer of "git could not say" is treated as "leave it alone": editing a
version-controlled file on a guess is worse than not editing it.

The append is newline-safe in both directions - a file not ending in a newline
gets one first, then a blank line, then the comment and the entry - and the file
is created when absent.

It also reuses the file's dominant line ending, so a CRLF `.gitignore` stays
CRLF. Two LF lines at the bottom of a CRLF file is a whole-file change in some
editors and a visible `^M` mismatch in others, which is a gratuitous edit in a
file Rasterwright is already touching more than it would like to. LF is the
default for a new file and for anything not already mostly CRLF.

A failure to append is reported and does not fail the run. The config is already
on disk at that point, and exiting 2, which means "nothing was written", would
be false about a run that wrote the file it was asked for.

### 21.8 Flag naming

`--keep-gitignore` opts out of the append. Deliberately not `--no-gitignore`:
that already means "do not skip git-ignored files" on `check` and `fix`, and
`init` keeps that flag with that same meaning for its own scan. `--skip-gitignore`
is worse than either, since it reads as "skip git-ignored files".

### 21.9 Refusals

`init` refuses to overwrite an existing config without `--force`, using the
`wx` open flag so the answer comes from the filesystem at the moment of the
write rather than from an `existsSync` a moment earlier.

The other spelling of the default name is directional, because `findConfig`
tries `.rasterwright.yml` first and `.rasterwright.yaml` second:

| Writing | Beside an existing | Result |
|---|---|---|
| `.rasterwright.yaml` | `.rasterwright.yml` | refused: nothing would ever read the new file |
| `.rasterwright.yml` | `.rasterwright.yaml` | written, with a note that the new file takes precedence |
| a `--config` name | either default | written, with a note naming what bare commands will load |

Only the first is a refusal, and only because the file would be dead on
arrival. Under `--force` it is written anyway, with the note saying plainly that
nothing will read it.

A target directory that does not exist is a refusal, not a `mkdir`. `init`
writes one file.

### 21.10 `--config` sets the root, so "scan here, write there" is not expressible

The directory holding the config is the project root, for `init` exactly as for
every other command, because the globs it writes are relative to that directory.
`init --config /tmp/x.yml` therefore scans `/tmp`, not the current directory.
That is correct - the alternative generates a config whose globs are wrong the
moment it is loaded - but it does mean there is no way to generate a config for
a project without writing into that project. Driving `runInit` directly is the
answer for a read-only trial run, and it is one of the reasons that function
writes nothing.

### 21.11 Exit codes

`0` when a config was written, even one that already flags files: `init`
succeeded at what it was asked to do, and the summary says how many. `2` when
nothing was written. There is no `1`; `init` is not a gate.

---

## 22. Packaging decisions

Added at the end of the packaging and agent-docs phase, which is the "only after
step 11" work section 13 sequenced last: `--json` polish, a `SKILL.md`, and the
packaging that makes both installable.

### 22.1 `private: true` stays

It blocks an accidental `npm publish` and interferes with nothing else. Both
`npm pack` and `npm install <tarball>` work with it set, verified end to end
against a disposable project. Removing it is a decision for whoever publishes,
and that is the same moment to add `repository`, `homepage` and `bugs`.

### 22.2 No `repository` field

There is no remote. Any value would be a guess, and a wrong `repository` is
worse than an absent one: npm renders it as a link, and `npm bugs` follows it.

### 22.3 No source maps in the tarball

`sourceMap: false` in `tsconfig.build.json` only. `tsconfig.json` keeps maps, so
tests, `tsx` and the typecheck are unaffected.

The maps were 48 files whose `sources` pointed at `../../src/*.ts`, and `src/`
is not in the package. A map that resolves to nothing is worse than no map: a
debugger steps into a file that does not exist. Shipping `src/` instead would
fix the resolution and grow the tarball, for a CLI nobody debugs from inside
`node_modules`. Dropping them took the unpacked size from 510 kB to 390 kB.

### 22.4 `prepare` runs the build

`files` lists `dist`, `dist/` is gitignored, and nothing rebuilt it on install.
A fresh clone followed by `npm pack`, or an `npm install <git-url>`, therefore
produced a package with no code in it and a `bin` entry pointing at a missing
file. It was the one packaging defect that failed silently, and at the consumer
rather than at pack time.

`prepare` is the right hook rather than `prepack`: npm runs it on `npm install`
in the checkout, on `npm pack`, and on an install from a git URL, which is every
path that needs `dist/` to exist. It is not run when installing the published
tarball, which already carries `dist/`.

### 22.5 The skill lives in `skills/rasterwright/SKILL.md`

Agent Skills are a directory per skill holding a `SKILL.md`, loaded from
`~/.claude/skills/<name>/` or `.claude/skills/<name>/`. Shipping that directory
shape means installing the skill is one `cp -r`, from the checkout or from
`node_modules/rasterwright/skills/`. A bare `SKILL.md` at the repo root would
need the user to create a directory and rename the file, and it would read as a
skill for agents working *on* Rasterwright rather than *with* it.

`skills` is added to `files` so the skill travels with the package. It is 7 kB.

The skill is an experiment, not a contract: section 9 of `03` asks whether a
`SKILL.md` changes agent behaviour enough to matter, and that question is still
open. It documents `--json` field names, which `src/cli/render/json.ts` still
says are not a stable public API, so the two have to be revised together.

### 22.6 What was deliberately not added

No `main` or `exports`. Rasterwright is a CLI, and an entry point would create a
library API surface the project has not designed and does not want to support.

No `keywords`. They matter only for registry search, which is not reachable
while the package is private.

No executable bit fixed in the build tree. `dist/cli/index.js` is mode `644`
there, and npm sets the bit on `bin` targets at install time. Verified:
`node_modules/.bin/rasterwright` is a correct relative symlink to a `755` file.
