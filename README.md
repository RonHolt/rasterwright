# Rasterwright

**An image policy and verification tool for software projects.**

Rasterwright governs the image assets that live in a repository. You write down
what those images are allowed to be - maximum dimensions, a byte ceiling, a
preferred format, no EXIF, sRGB - and Rasterwright tells you which files break
the rules, and what it would do about each one.

It is the ESLint-shaped layer for images: opinions about the source you commit,
not a replacement for your build system's asset pipeline.

## Status

**Early, personal, open-source. Two read-only commands work today: `check`
and `fix --dry-run`.**

This is a tool built because its author wanted to use it. It is not a product,
there is nothing to buy, and it makes no network calls, collects no telemetry
and has no accounts. Broader use is welcome; adoption is not a goal.

What exists right now:

| Command | Status |
|---|---|
| `rasterwright check` | Implemented, read-only |
| `rasterwright fix --dry-run` | Implemented, read-only. Reports the plan it would execute. |
| `rasterwright fix` | **Not implemented.** Refuses to run. |
| `rasterwright review` | Not implemented |
| `rasterwright init` | Not implemented |

Nothing in this build writes an image byte. `fix --dry-run` decides what
Rasterwright *would* do and prints it; there is no executor behind it yet, and
plain `rasterwright fix` exits with an error rather than quietly behaving as a
dry run.

Both commands' read-only guarantee is enforced by integration tests that
snapshot the path, size, mode, mtime and content hash of every file in a
project - and the set of directories - before and after a run, and assert they
are identical.

## Install (development)

There is no published package. Clone the repository and work from source.

```bash
git clone <this repo>
cd rasterwright
npm install
npm test
npm run build
```

Requires Node.js 20 or newer.

Run it against a project:

```bash
# from inside the project you want to check
node /path/to/rasterwright/dist/cli/index.js check
node /path/to/rasterwright/dist/cli/index.js fix --dry-run
node /path/to/rasterwright/dist/cli/index.js fix --dry-run --allow-renames

# or, during development, from the rasterwright checkout
npm run rasterwright -- check --config /path/to/project/.rasterwright.yml
```

Both commands resolve the project root from wherever the config file lives, so
the second form works from anywhere. Neither writes anything.

## Configuration

Rasterwright looks for `.rasterwright.yml` (or `.rasterwright.yaml`) in the
current directory, then upwards. The directory holding it is the project root,
and every path Rasterwright prints is relative to that root.

```yaml
version: 1

defaults:
  upscale: false
  stripMetadata: true
  autoOrient: true
  colorSpace: srgb

rules:
  # Byte sizes are 1024-based: 500kb means 512000 bytes.
  "assets/**/*.{jpg,jpeg,png,webp}":
    maxWidth: 2400
    maxBytes: 500kb

  "assets/heroes/**":
    maxWidth: 2400
    maxBytes: 400kb
    format: webp
```

### Properties

| Property | Meaning |
|---|---|
| `maxWidth`, `maxHeight` | Maximum displayed dimensions, in pixels. |
| `maxBytes` | A **ceiling**, not a target. Rasterwright never grows a file to consume unused budget. |
| `format` | Preferred format: `jpeg` (or `jpg`), `png`, `webp`. A different current format is an error. |
| `stripMetadata` | Default `true`. A normalization **preference**, not a gate: it means "if Rasterwright rewrites this file, drop the ancillary metadata". Produces warnings, never errors. ICC profiles are excluded. |
| `autoOrient` | Default `true`. Normalize a non-normal EXIF orientation flag. Set `false` and Rasterwright reports nothing about orientation. |
| `colorSpace` | Only `srgb` is supported. |
| `upscale` | Always `false`. Rasterwright never enlarges an image. |
| `quality` | `{ start, floor }` for the future encoder. `start` is the **maximum** quality it will encode at, not a target; quality is only ever searched downward, and only when the byte ceiling is exceeded. |

### Byte units are 1024-based

`500kb`, `500KB`, `500 KiB` and `500k` all mean **512000 bytes**. `1mb` means
1048576 bytes. Plain numbers (`512000`) are bytes.

This is a coin flip either way - SI says 1000 - and Rasterwright picks 1024
because that is the number your file browser and `ls -lh` already showed you.

### Rule precedence

```
defaults
  + first matching rule
  + next matching rule
  + ...
  = effective rule
```

Every rule whose glob matches the file is applied, **in the order the globs
appear in the config file**. Merging is shallow and per-property: a later
matching rule overrides only the properties it actually sets.

In the example above, `assets/heroes/hero.jpg` ends up with `maxWidth: 2400` and
`format: webp` from the second rule, and keeps `maxBytes` from whichever rule set
it last. A rule setting only `format` would leave an earlier `maxWidth` intact.

Specificity is deliberately not considered. File order is the only thing that
decides, because that is the only rule that is easy to predict by reading.

### Glob case sensitivity follows the platform

| Platform | Matching |
|---|---|
| Windows | case-insensitive |
| Linux | case-sensitive |
| macOS | case-sensitive |

macOS is usually case-insensitive on disk, but only usually - case-sensitive
volumes exist, and probing the filesystem would make matching depend on where
the repository happens to live. Case-sensitive is the predictable answer and it
agrees with CI, which is nearly always Linux.

The consequence: on macOS and Linux, `assets/**/*.jpg` does not govern
`assets/HERO.JPG`. That file is discovered, matched by nothing, and skipped.
Write the glob to cover the casing you actually use.

### What gets checked

Rasterwright discovers `.jpg`, `.jpeg`, `.png` and `.webp` files under the
project root (extension matching during discovery is case-insensitive) and
always skips `.git/`, `node_modules/`, `.rasterwright/` and hidden directories.

Git-ignored files are skipped too. That is implemented by asking
`git check-ignore`, which gets nested `.gitignore` files, negations and global
excludes exactly right for free. Outside a git work tree, or when git is
unavailable, the filter cannot run: Rasterwright then checks everything it
found and says so on stderr. `--no-gitignore` disables the filter deliberately.

**A file matched by no rule is silently skipped.** It is counted in the summary
and is not an error.

## Severity

Every finding is an **error**, a **warning** or an **info** note.

| Severity | Meaning | Affects exit code |
|---|---|---|
| `error` | The repository contract is broken. | Yes |
| `warning` | Worth fixing; the repo is not wrong. | No |
| `info` | An observation that explains what a future `fix` would do. | No |

The split exists because of the first run against a real theme: it found 3
genuine constraint violations and 17 files carrying harmless EXIF. Treating
those the same made the useful findings unreadable, and would have trained
everyone to ignore the tool.

So the human report answers *what should I care about?* before *what did
Rasterwright find?* - errors get a block each, warnings are counted and
summarized, notes are hidden until you ask. `--json` stays exhaustive.

### Checks

| Check | Severity | What it reports |
|---|---|---|
| `maxWidth` / `maxHeight` | error | Displayed dimensions exceed the limit. Displayed means after the EXIF orientation flag is applied, because that is what a browser lays out. |
| `maxBytes` | error | File size exceeds the ceiling. |
| `format` | error | Current format differs from the preferred one. |
| `extension` | error | The file extension disagrees with the actual encoded format. |
| `colorSpace` | error | The image is confidently not sRGB. |
| `orientation` | error | A non-normal EXIF orientation flag, when `autoOrient` is on. |
| `decode` | error | A governed image that could not be read or decoded. |
| `metadata` | warning | EXIF, XMP, IPTC or other ancillary blocks are present while `stripMetadata` is on. |
| `colorSpaceUnknown` | info | An ICC profile is present but could not be identified. |
| `animated` | info | Animated image; v0 does not transform these. |
| `ruleGlobExcludesTargetFormat` | info | Converting this file would take it out of every rule that governs it. |

### Extension versus contents

A real theme contained `bokka-logo-transparent.png` that Sharp decodes as WebP.
Every other check reads the format from the file's *contents*, so the file
looked entirely healthy.

Extensions are load-bearing well outside Rasterwright: web servers pick a
Content-Type from them, bundlers pick a loader, CDNs and caches key on them.
A `.png` that is really a WebP is a latent bug in every one of those, so a
mismatch is an error. `.jpg` and `.jpeg` are the same format and never a
mismatch.

### Metadata and ICC profiles are different things

`stripMetadata: true` covers EXIF, XMP, IPTC and other ancillary blocks. It
does **not** cover ICC profiles.

A colour profile is colour management, not disposable baggage. An image tagged
`sRGB IEC61966-2.1` or `GIMP built-in sRGB` under `colorSpace: srgb` is doing
exactly what was asked, and Rasterwright says nothing about it. Profiles are
used to determine colour-space status, not counted as clutter.

### Things Rasterwright will not claim to know

- **Colour space is three-valued.** Confidently sRGB, confidently not sRGB, or
  unknown. An image carrying an ICC profile Rasterwright cannot identify is a
  note, never an error - a false positive here would train you to ignore the
  tool. It is also not silently counted as compliant.
- **Transparency is measured, not narrated.** An alpha channel whose every pixel
  is opaque carries no information and does not block a JPEG conversion. When
  opacity could not be determined, Rasterwright assumes transparency, because
  the failure mode of guessing wrong is a black box where a logo used to be.

  Having alpha is not itself a finding - it is a property of most PNGs, and
  reporting it produced 55 notes on the first real project. `hasAlpha` and
  `isOpaque` stay in `--json` on the image record, and transparency speaks up
  only where it changes an answer: a `format: jpeg` rule against an image with
  real alpha, which reports the `format` finding as unfixable. An unused alpha
  channel is never a violation, and a future `fix` will not rewrite a file just
  to drop one.
- **Metadata detection is honest.** Rasterwright reports what Sharp exposes -
  EXIF, XMP, IPTC, Photoshop tags, PNG text - and does not pretend to inventory
  every ancillary chunk.
- **`check` never encodes.** Whether a file can be brought under a byte ceiling
  depends on what the encoder produces, and finding out means encoding. `check`
  inspects and evaluates; `fix` transforms. That boundary is what keeps `check`
  read-only and fast.

### Fixability

Each finding, and each file, reports whether a future `fix` could resolve it:

- **yes** - a deterministic transform resolves it.
- **no** - it cannot be resolved safely. The common case is a transparent image
  under a `format: jpeg` rule: JPEG cannot represent an alpha channel, and
  Rasterwright will not guess a background colour.
- **unknown** - nothing is blocking, but the answer depends on encoding.
  `maxBytes` is the only check that lands here; the report says
  `Fix requires encoding`.
- **n/a** - informational findings, which have nothing to fix.

Some fixes rename the file - a format conversion (`hero.png` -> `hero.webp`),
or correcting an extension that disagrees with its contents. Renames can break
references in source code, so `fix` requires explicit per-run authorization
(`--allow-renames`) before planning one. `check` reports them either way; see
[`rasterwright fix --dry-run`](#rasterwright-fix---dry-run).

## `rasterwright check`

```
$ rasterwright check
Rasterwright

ERRORS

✗ assets/heavy.jpg

    maxBytes      457 KB            allowed: 200 KB
    Fix requires encoding

✗ assets/heroes/hero.jpg

    format        JPEG              expected: WebP
    converting renames the file, so fix will need --allow-renames

✗ assets/icons/logo.png

    format        PNG               expected: JPEG
    Not safely fixable: transparency present, and JPEG cannot represent it

✗ assets/logo-webp.png

    extension     PNG
    contents      WebP

    File extension does not match the encoded image format.

✗ assets/oversized.jpg

    maxWidth      2000 px           allowed: 1200 px

WARNINGS

⚠ 3 images contain removable metadata
    2 with EXIF
    1 with XMP

    Run with --verbose to list them.

15 images checked
7 files with errors
3 files with warnings
6 clean
1 image matched no rule and was skipped
```

`--verbose` expands the warning summary into one block per file, and adds a
`NOTES` section when there are informational findings to show. It does not
change the exit code. Notes are for the genuinely exceptional - an
unidentifiable colour profile, an animated image, a rule whose format target
escapes its own glob - not for ordinary image properties.

## `rasterwright check --json`

For scripts and coding agents. stdout carries JSON and nothing else;
diagnostics go to stderr. Where the human report summarizes, this stays
exhaustive: every finding on every checked file, compliant ones included,
because "this file is governed and passes" is useful to an agent about to add
another image next to it.

```json
{
  "rasterwrightVersion": "0.1.0",
  "clean": false,
  "configPath": "/repo/.rasterwright.yml",
  "root": "/repo",
  "summary": {
    "checked": 15,
    "clean": 6,
    "withWarnings": 3,
    "withErrors": 7,
    "errors": 7,
    "warnings": 3,
    "infos": 0,
    "unreadable": 0,
    "ignored": 1
  },
  "files": [
    {
      "path": "assets/logo-webp.png",
      "status": "error",
      "image": {
        "path": "assets/logo-webp.png",
        "bytes": 1024,
        "format": "webp",
        "width": 300,
        "height": 200,
        "storedWidth": 300,
        "storedHeight": 200,
        "hasAlpha": true,
        "isOpaque": false,
        "bitDepth": 8,
        "pixelColorSpace": "srgb",
        "colorSpaceStatus": "srgb",
        "hasIccProfile": false,
        "iccDescription": null,
        "hasExif": false,
        "hasXmp": false,
        "hasIptc": false,
        "hasOtherMetadata": false,
        "orientation": 1,
        "isAnimated": false,
        "contentHash": "1b1f..."
      },
      "policy": {
        "upscale": false,
        "stripMetadata": true,
        "autoOrient": true,
        "colorSpace": "srgb",
        "maxWidth": 1200,
        "maxBytes": 204800
      },
      "matchedGlobs": ["assets/**/*.{jpg,jpeg,png,webp}"],
      "findings": [
        {
          "path": "assets/logo-webp.png",
          "rule": "(built-in)",
          "check": "extension",
          "severity": "error",
          "actual": "WebP",
          "allowed": "PNG",
          "fixable": "yes",
          "message": "contents are WebP but the extension says PNG; fix would rename the file to match its contents, so it will need --allow-renames"
        }
      ],
      "fixable": "yes"
    }
  ],
  "diagnostics": []
}
```

`status` on a file is the highest severity it produced: `clean`, `info`,
`warning` or `error`. `withWarnings` and `withErrors` are counted
independently - a file with both appears in each. Files matched by no rule do
not appear at all; they are only counted in `summary.ignored`.

`rule` is the glob that supplied the value, or `(defaults)` for the defaults
block, or `(built-in)` for checks with no config key.

This shape is not a stable public API yet.

## `rasterwright fix --dry-run`

`fix` turns findings into a **plan**: the ordered operations that would make a
file comply. `--dry-run` prints that plan and stops.

**It writes nothing.** No image bytes, no temp file, no cache, no manifest, no
backup, no rename. It runs `check`'s read-only pipeline and reasons over the
result.

```
$ rasterwright fix --dry-run
Rasterwright Fix Plan

WOULD FIX

→ assets/src/images/cah-form-osc.png

    encode        PNG
    target        <= 500 KB
    transparency  preserve
    metadata      strip during the rewrite above
    result        must be verified during execution
    note          PNG is lossless, so the only lever is a maximum-effort re-encode; the ceiling may be unreachable

→ assets/src/images/nolanville_skinny-scaled.jpg

    resize        2560x1001 -> 2400x938
    encode        JPEG
    ceiling       <= 500 KB
    quality       82, searched down to 40 if needed
    re-encode     lossy source re-encoded; some generation loss
    result        must be verified during execution

REQUIRES PERMISSION

⊘ assets/src/images/bokka-logo-transparent.png

    rename        .png -> .webp
    path          assets/src/images/bokka-logo-transparent.webp
    pixels        already in the target format; no re-encode required
    blocked       correcting the extension renames this file, which can break references to it
    permission    rerun with --allow-renames

LEFT UNCHANGED

23 images carry warnings only

    Metadata is normalized during a rewrite an error already required,
    never as a reason to rewrite a compliant file.

75 images inspected
3 files would be modified
1 file requires permission
23 warning-only files left unchanged
48 already compliant
1 image matched no rule and was skipped

Nothing was written. This is a plan, not a run.
Rerun with --allow-renames to plan the filename changes above.
Executing a plan is not implemented yet.
```

### Plain `rasterwright fix` is not implemented

```
$ rasterwright fix
rasterwright: fix execution is not implemented yet.
  Use `rasterwright fix --dry-run` to inspect the planned changes.
```

Exit code `2`. It is deliberately **not** a silent alias for `--dry-run`.
Quietly making the dangerous command safe teaches the habit of typing the
dangerous command, which is exactly the muscle memory not to build before an
executor exists.

### One file, one plan

A file's findings do not become a list of independent fixes. An image that is
too wide, over budget, in the wrong format and carrying EXIF is resized once,
encoded once, and renamed once. Operations are emitted in execution order:

| # | Operation | Notes |
|---|---|---|
| 1 | `autoOrient` | First: it changes the dimensions everything downstream depends on. |
| 2 | `resize` | Down only, `fit: inside`, both dimensions rounded **down** so the result can never land a pixel over a limit. |
| 3 | `toColorSpace` | After geometry, before the encoder. Only for a confident non-sRGB error. |
| 4 | `encode` | Exactly one per file. Metadata stripping is an encoder setting, not a second pass. |
| 5 | `rename` | Last, so no output has to be reopened under a new name. |

A compliant file is never re-encoded. A file is never encoded twice in one run.

### `autoOrient: false` keeps the flag, even through a rewrite

`autoOrient: false` says "leave the orientation flag alone". It does not say
"leave the file alone", so some other error can still force a rewrite, and an
encoder drops metadata by default. Left to itself that rewrite would clear the
flag while leaving the pixels unrotated, and an image that displayed as 400x600
would start displaying as 600x400.

So the encode carries the flag through instead, and the plan says so:

```
→ kept-oversized/rotated.jpg

    resize        400x600 -> 300x450
    encode        JPEG
    quality       82
    orientation   EXIF flag preserved; the pixels are not rotated
    re-encode     lossy source re-encoded; some generation loss
    metadata      strip during the rewrite above
    note          autoOrient is off, so EXIF orientation 6 is preserved through the rewrite and a minimal EXIF block remains; later checks report that as a metadata warning
```

The note is the honest half. Preserving the flag means writing a small EXIF
block into a file that may have had none, so the next `check` reports a metadata
warning on it. That is expected. Warnings never justify a rewrite, so the file is
not touched again.

### File statuses

| Status | Meaning |
|---|---|
| `unchanged` | Nothing to do. No error-level findings. |
| `planned` | A complete plan exists and this run could execute it. |
| `requires-permission` | A plan exists, but the run lacks permission for it. |
| `blocked` | The plan is complete and permitted, but its output path collides with another plan or with something that already exists. A blocked file can carry more than one conflict. |
| `unfixable` | No safe transform resolves it, or the image could not be decoded. |
| `unsupported` | v0 does not rewrite this kind of image at all. Today: animated images, and 16-bit sources, whose precision an 8-bit encoder would silently halve. A rename touches no pixels, so an extension correction on either is still performed. |

### `--allow-renames` is execution permission, not policy

Two operations change a filename, and both can break a reference in source code:

1. a **format conversion** - `hero.jpg` -> `hero.webp`;
2. an **extension correction** - `logo.png` whose bytes are already WebP
   becoming `logo.webp`, with no pixel change at all.

That the second rewrites no pixels does not make it safer, so both need
`--allow-renames`. It is a property of the *invocation*, not of the repository,
so there is deliberately no `allowRenames` config key.

Without the flag the file's whole plan is blocked - not just the rename:

```
image.png   (bytes are WebP, and it is also too wide)

  without --allow-renames:  requires-permission, no operations at all
  with    --allow-renames:  resize, encode, rename
```

Resizing a file Rasterwright is about to leave deliberately mis-named would
spend a lossy re-encode the authorized run has to spend again, and would end
the run having knowingly produced a file that is still invalid. A plan is
applied coherently or not applied.

The blocked plan is still reported, under `blockedOperations` in `--json` and
in the `REQUIRES PERMISSION` section of the human report, so granting
permission is a decision rather than a leap.

### An extension correction rewrites no pixels

`logo.png` holding WebP bytes needs its *name* fixed and nothing else. The plan
is a single `rename` with `reencode: false`; decoding and re-encoding a
perfectly good image to correct a filename would be pure generation loss.

The exception is when the policy pins the format back to what the extension
claims: under `format: png`, that same file is re-encoded to real PNG and keeps
its name, so no rename and no permission are involved.

### Metadata is normalized opportunistically, never on its own

`stripMetadata: true` means *if Rasterwright rewrites this file, drop the
ancillary metadata*. It never means *rewrite a compliant file to clear EXIF*.

| Findings | Plan |
|---|---|
| metadata warning only | `unchanged`, no operations |
| an error **and** a metadata warning | the rewrite the error required also strips metadata |

So metadata warnings can persist indefinitely on files nothing else touches.
That is the correct outcome: producing a diff on a file nobody said was wrong is
exactly the surprise this tool exists to avoid. There is no `--include-warnings`
and no `--fail-on-warnings`.

### Byte budgets stay honest

Planning has not encoded anything, so it does not predict an output size. An
encode against a ceiling reports the target and the fact that the outcome must
be measured:

```
    target        <= 500 KB
    result        must be verified during execution
```

There is no "expected output: 432 KB" anywhere, because producing that number
means encoding, and encoding is execution's job.

`target` and `ceiling` are different labels on purpose: `target` means the byte
budget is *why* this encode is planned, `ceiling` means it is a limit that also
applies to a rewrite something else required.

PNG gets an extra note. It is lossless, so the only lever is a maximum-effort
re-encode worth a few percent; palette quantization is deliberately not in v0
because it wrecks photographs. An arbitrary PNG byte budget may simply be
unreachable, and the plan says so rather than implying success.

### The whole batch is checked, not just each file

Planning is per file and reads nothing beyond that file's own inspection
result. Two plans that are each perfectly correct can still destroy a file
between them, so the plan set gets a **preflight** pass before anything is
reported. It catches:

| Conflict | Example |
|---|---|
| `duplicate-target` | `hero.jpg` and `hero.png` both converting to `hero.webp`. |
| `target-exists` | `logo.png` holding WebP bytes being renamed onto a `logo.webp` that already exists. |
| `source-claimed` | Another plan would rename onto *this* file's current path while this file moves away. |
| `target-unreadable` | The target path could not be checked at all, so whether it is free is unknown. |

```
BLOCKED

⊗ assets/hero.jpg

    encode        WebP
    quality       82
    re-encode     lossy source re-encoded; some generation loss
    rename        .jpg -> .webp
    path          assets/hero.webp
    conflict      assets/hero.png is renamed to assets/hero.webp, so assets/hero.webp is claimed by more than one plan
```

Every plan involved is marked `blocked`. Rasterwright does not pick a winner
between two plans claiming one path, and it does not order renames so a chain
can thread itself through - `A.png -> A.webp` while `A.webp -> A.jpg` blocks
both ends. Sequencing would work right up until the run is interrupted halfway,
and then a file is gone with no record of where it went. A refused batch costs
one rerun after a rename; a lost image is permanent.

Occupancy is read from two places, and nothing else touches the disk: the file
list `check` already walked, plus one `lstat` per rename target that list did
not cover. The second matters because a target need not be an image - a
directory, a symlink or a `.txt` file holds the name just as firmly.

A probe that fails is not a probe that passed. "Nothing is there" is the one
answer that frees the path; every other errno - `EACCES` on an unreadable
parent, `ENOTDIR`, `ELOOP`, `ENAMETOOLONG` when the new extension pushes the
filename past the limit - blocks the plan with the errno named, and prints a
diagnostic on stderr rather than a stack trace.

On macOS and Windows, paths are compared with case folded, so `Hero.webp` and
`hero.webp` collide. That is deliberately not symmetrical with glob matching,
which is case-sensitive on macOS and Linux (see "Glob case sensitivity follows
the platform"): matching the wrong file is a reporting bug, and overwriting the
wrong file is data loss.

A file waiting on `--allow-renames` has no rename yet, so it has nothing to
collide with. **Granting `--allow-renames` can therefore surface conflicts an
earlier run had no way to report.** That is the flag working, not a regression.

### A lossy re-encode is stated, not hidden

Re-encoding an already-lossy image is allowed when an error-level finding
demands it - a WebP over its ceiling under `format: webp` is re-encoded in
place, no rename, no permission. Generation loss is real, so the plan says
`re-encode  lossy source re-encoded; some generation loss` rather than
presenting it as a free saving.

## `rasterwright fix --dry-run --json`

Same rules as `check --json`: stdout carries JSON and nothing else, diagnostics
go to stderr. `files` lists every file that is **not** `unchanged` - unchanged
files are counted in the summary and omitted, because `check --json` already
describes them and repeating it would bury the files a fix would touch.

```json
{
  "rasterwrightVersion": "0.1.0",
  "dryRun": true,
  "permissions": { "allowRenames": false },
  "complete": false,
  "configPath": "/repo/.rasterwright.yml",
  "root": "/repo",
  "summary": {
    "checked": 75,
    "planned": 3,
    "requiresPermission": 1,
    "blocked": 0,
    "unfixable": 0,
    "unsupported": 0,
    "unchanged": 71,
    "unchangedWithWarnings": 23,
    "operations": 4,
    "ignored": 1
  },
  "conflicts": [],
  "files": [
    {
      "path": "assets/src/images/nolanville_skinny-scaled.jpg",
      "targetPath": "assets/src/images/nolanville_skinny-scaled.jpg",
      "status": "planned",
      "operations": [
        {
          "op": "resize",
          "from": { "width": 2560, "height": 1001 },
          "to": { "width": 2400, "height": 938 },
          "maxWidth": 2400,
          "fit": "inside",
          "upscale": false
        },
        {
          "op": "encode",
          "format": "jpeg",
          "budgetDriven": false,
          "stripMetadata": true,
          "preserveAlpha": false,
          "lossyReencode": true,
          "outcomeRequiresVerification": true,
          "maxBytes": 512000,
          "quality": { "start": 82, "floor": 40 }
        }
      ],
      "blockedOperations": [],
      "resolves": ["maxWidth"],
      "unresolved": [],
      "normalizedDuringRewrite": [],
      "warnings": [],
      "requiresVerification": true,
      "requiredPermissions": [],
      "reasons": [],
      "notes": []
    }
  ],
  "diagnostics": []
}
```

`complete` is `true` when every error-level finding is covered by a plan this
run could actually execute - nothing waiting on permission, blocked by a path
conflict, unfixable or unsupported. It is what the exit code is derived from.
Warnings are irrelevant to it.

`conflicts` is empty when the batch is executable. Each entry corresponds to
one `blocked` file and names what it collided with:

```json
{
  "path": "assets/hero.png",
  "targetPath": "assets/hero.webp",
  "kind": "duplicate-target",
  "caseOnly": false,
  "with": ["assets/hero.jpg"],
  "message": "assets/hero.jpg is renamed to assets/hero.webp, so assets/hero.webp is claimed by more than one plan"
}
```

`caseOnly` is `true` when the paths collide only because the filesystem folds
case. `with` names the competing plans, or the file already occupying the path.
`targetPath` is the path that collided, which for `source-claimed` is the
blocked plan's own current path rather than its output. One file can appear
more than once: a pair of renames that swap places collides in two different
ways at once.

`resolves` and `unresolved` name the checks a plan would and would not clear.
`normalizedDuringRewrite` names warnings that get cleaned up for free on the
way through. `requiresVerification` says the outcome depends on encoding results
planning cannot know.

This shape is not a stable public API yet.

## Exit codes

One model, both commands. Warnings never produce a non-zero exit.

| Code | `check` | `fix --dry-run` |
|---|---|---|
| `0` | No error-level findings. | Every error is covered by a plan this run could execute (or there are none). |
| `1` | At least one error. | At least one file is left unresolved: waiting on permission, blocked by a path conflict, unfixable, or unsupported. |
| `2` | Configuration or runtime error. Nothing was checked. | Same. Plain `fix` without `--dry-run` also exits `2`. |

An unreadable image is an exit `1`, not a `0`: it is a file that is supposed to
be governed and is not being governed. The rest of the batch still runs.

So `fix --dry-run` exiting `0` means "Rasterwright has a complete plan it could
execute", which is the useful thing to gate automation on.

## Options

```
rasterwright check [options]

  -c, --config <path>  path to .rasterwright.yml (default: nearest one, searching upwards)
  --json               emit machine-readable JSON on stdout instead of a report
  -v, --verbose        list every warning and note individually instead of summarizing
  --no-gitignore       do not skip git-ignored files
  --concurrency <n>    number of images to inspect in parallel

rasterwright fix [options]

  -c, --config <path>  path to .rasterwright.yml (default: nearest one, searching upwards)
  --dry-run            report what fix would do, and write nothing (required today)
  --allow-renames      permit operations that change a filename
  --json               emit machine-readable JSON on stdout instead of a report
  --no-gitignore       do not skip git-ignored files
  --concurrency <n>    number of images to inspect in parallel
```

## Planned

Clearly labelled as **not built**:

- **Executing a plan.** Everything `fix --dry-run` describes - auto-orient,
  downscale, colour conversion, one encode with a downward quality search
  against the byte ceiling, atomic temp-file-plus-rename writes, per-file
  failure isolation, and verification of the output against policy. The plans
  exist; nothing applies them yet, on purpose. Rasterwright gets permission to
  change pixels after its plans have been read on real repositories.
- `rasterwright review` - a local static HTML before/after page.
- `rasterwright init` - a starter config generated from what a repo already
  contains.

Deferred, with the reasoning recorded in `04-v0-technical-plan.md` section 14:
a `preferredFormat` distinct from a hard `format` requirement, a `--strict`
mode that promotes unknown colour space to an error, and any caching.

Deliberately out of scope: any GUI, any chatbot, any model inference, an MCP
server, a plugin system, accounts, telemetry, and a hosted anything.

## Development

```bash
npm install          # install dependencies
npm test             # vitest, generates image fixtures automatically
npm run typecheck    # tsc --noEmit over src, tests and scripts
npm run build        # compile to dist/
npm run fixtures     # regenerate fixtures/images and fixture projects
npm run rasterwright -- check --config <path>   # run from source
```

### Layout

```
src/
  cli/         commander wiring, exit codes, human and JSON renderers
  config/      load, validate and resolve .rasterwright.yml
  scanner/     file discovery and Sharp-based inspection
  policy/      pure functions: ImageInfo + rule -> findings
  operations/  pure functions: findings + permissions -> PlannedOperation[]
  utils/       byte parsing, hashing, ICC reading, paths, concurrency
  run-check.ts the read-only check pipeline
  run-fix.ts   check's pipeline plus planning
```

The architecture is `policy -> analysis -> operation plan -> execution ->
verification`. **This build stops after the operation plan.** `operations/plan.ts`
exists; `operations/execute.ts` does not.

The CLI never calls Sharp directly. `policy/` and `operations/plan.ts` are pure
functions over plain data - the planner reads nothing beyond the `FileResult` it
is handed, calls no Sharp, and touches no filesystem, which is what makes plans
deterministic and testable without a single image file. Nothing on either
command's path imports anything that writes, which is what makes both read-only
by construction rather than by discipline.

Fixture images are generated by `scripts/generate-fixtures.ts` rather than
committed as binaries. They are real files produced by Sharp, deterministic, and
regenerated automatically before the test suite runs. The fixture projects'
`.rasterwright.yml` files are committed, because those are the part worth
reading in a diff.

Sharp is pinned to an exact version. Encoder behaviour will eventually determine
output bytes, and a floating range would make that non-reproducible.

## Licence

MIT.
