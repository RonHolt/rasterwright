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

**5. Budget-driven plans are skipped, not attempted.** `EncodeOperation.
budgetDriven` marks the plans where a byte ceiling is the *reason* for the
encode, and the quality search does not exist until the byte-budget phase.
`renderCandidate()` throws on one rather than encoding something it cannot
verify, and the executor must report those files as `skipped` with a plain
reason *before* any encoding happens. Failing after a wasted encode would read
as a bug rather than as a stated limitation, and `maxBytes` is common enough in
real configs that the phase would look broken.

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
happened instead: the single encode at `quality.start` produced N, the ceiling
is M, and the search that would go lower does not exist yet. Correct behaviour,
stated as a limitation rather than looking like one.

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
