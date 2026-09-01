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
