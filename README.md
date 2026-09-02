# Rasterwright

**An image policy and verification tool for software projects.**

Rasterwright governs the image assets that live in a repository. You write down
what those images are allowed to be - maximum dimensions, a byte ceiling, a
preferred format, no EXIF, sRGB - and Rasterwright tells you which files break
the rules, and what it would do about each one.

It is the ESLint-shaped layer for images: opinions about the source you commit,
not a replacement for your build system's asset pipeline.

## Status

**Early, personal, open-source. All four commands work today.**

This is a tool built because its author wanted to use it. It is not a product,
there is nothing to buy, and it makes no network calls, collects no telemetry
and has no accounts. Broader use is welcome; adoption is not a goal.

What exists right now:

| Command | Status |
|---|---|
| `rasterwright init` | Implemented. Writes a starter config measured from the images already here. |
| `rasterwright check` | Implemented, read-only |
| `rasterwright fix --dry-run` | Implemented, read-only. Reports the plan it would execute. |
| `rasterwright fix` | Implemented, byte budgets included. |
| `rasterwright review` | Implemented. A local before/after page for the last run. |

`rasterwright init` gets you a config in one command: it reads every image in
the repository and writes limits rounded up from what it finds, then tells you
exactly how many files the config it just generated would flag.

`check` and `fix --dry-run` write nothing at all. Their read-only guarantee is
enforced by integration tests that snapshot the path, size, mode, mtime and
content hash of every file in a project - and the set of directories - before
and after a run, and assert they are identical. `init` is held to a narrower
version of the same test: the config it was asked for, plus `.gitignore` in a
git repository, and nothing else in the tree changed at all.

Plain `fix` writes, and only after its preconditions have passed. Every write
is a verified buffer, a temp file in the same directory, an fsync and an atomic
rename; the original is byte-for-byte untouched until a candidate has been
generated in memory and evaluated against policy. A file over its `maxBytes` is
brought under it by searching quality downward, and a ceiling the policy's own
quality floor cannot reach is an explicit failure that names the best size
achieved and what to do about it - never a quietly degraded file.

`fix` also keeps a copy of every original it overwrites, under
`.rasterwright/review/`, and `rasterwright review` renders those copies and the
current files into one static HTML page you open in a browser. Seeing the pixels
is the point: a tool that reports "saved 61%" across 130 images has not told you
whether any of them still look right.

## Install

There is no published package. Clone the repository and install from it
locally.

```bash
git clone <this repo>
cd rasterwright
npm install
npm test
```

Requires Node.js 20 or newer. `npm install` runs the build, so `dist/` is
present afterwards.

Install it into a project as a normal dependency, from a tarball:

```bash
# in the rasterwright checkout
npm pack                      # writes rasterwright-0.1.0.tgz

# in the project you want to govern
npm install /path/to/rasterwright-0.1.0.tgz
npx rasterwright init
npx rasterwright check
```

`npm install /path/to/rasterwright` works too, and links the checkout instead
of copying it, so edits in the checkout are live in the project.

Or run it out of the checkout without installing anything:

```bash
# from inside the project you want to check
node /path/to/rasterwright/dist/cli/index.js check
node /path/to/rasterwright/dist/cli/index.js fix --dry-run
node /path/to/rasterwright/dist/cli/index.js fix --dry-run --allow-renames

# or, during development, from the rasterwright checkout
npm run rasterwright -- check --config /path/to/project/.rasterwright.yml
```

Every command resolves the project root from wherever the config file lives, so
the last form works from anywhere.

## For coding agents

The agent interface is the CLI, `--json`, and the skill shipped in
`skills/rasterwright/`. There is no MCP server and no library API, by design:
the CLI is a contract a shell can hold, and an integration is a thing to
maintain.

Install the skill for a coding agent that reads Agent Skills:

```bash
cp -r skills/rasterwright ~/.claude/skills/
# or, from a project that installed the package
cp -r node_modules/rasterwright/skills/rasterwright ~/.claude/skills/
```

The loop is three commands: `rasterwright check --json` to read the state,
`rasterwright fix --dry-run --json` to read the plan, `rasterwright fix` to
apply it, then `check` again to confirm. Exit codes are the contract: `0` clean,
`1` findings that need attention, `2` nothing ran. With `--json`, stdout carries
exactly one JSON document and every diagnostic goes to stderr.

## Configuration

Rasterwright looks for `.rasterwright.yml` (or `.rasterwright.yaml`) in the
current directory, then upwards. The directory holding it is the project root,
and every path Rasterwright prints is relative to that root.

`rasterwright init` writes a first one for you, with limits measured from the
images already in the repository. Everything below is what that file can say.

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
| `quality` | `{ start, floor }`, the band the encoder searches. Defaults are `start: 82` and `floor: 40`; both are integers from 1 to 100, and a `floor` above `start` is a config error. `start` is the **maximum** quality Rasterwright will encode at, not a target; quality is only ever searched downward, and only when the byte ceiling is exceeded. |

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
| `info` | An observation that explains what `fix` would do. | No |

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
| `ruleGlobExcludesTargetFormat` | info | Converting this file would land it on a path no glob in the policy matches, so nothing would govern it afterwards. |

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
  channel is never a violation, and `fix` does not rewrite a file just to drop
  one.
- **Metadata detection is honest.** Rasterwright reports what Sharp exposes -
  EXIF, XMP, IPTC, Photoshop tags, PNG text - and does not pretend to inventory
  every ancillary chunk.
- **`check` never encodes.** Whether a file can be brought under a byte ceiling
  depends on what the encoder produces, and finding out means encoding. `check`
  inspects and evaluates; `fix` transforms. That boundary is what keeps `check`
  read-only and fast.

### Fixability

Each finding, and each file, reports whether `fix` could resolve it:

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

## `rasterwright init`

Writes a starter `.rasterwright.yml`, with limits taken from the images already
in the repository.

```
$ rasterwright init
rasterwright: scanned 76 images (78 skipped by .gitignore)
rasterwright: wrote 1 rule:
    assets/src/images/**/*.{jpg,jpeg,png,webp}
      75 images, maxWidth 2000, maxBytes 300kb, 3 over those limits today
rasterwright: 1 image matched no rule and is not governed
rasterwright: `check` would report 5 errors and 24 warnings against this config
rasterwright: added .rasterwright/ to .gitignore
rasterwright: next: run `rasterwright check`
.rasterwright.yml
```

The summary is on stderr and the path is on stdout, like every other command.

The generated file is commented, because the comments are the point:

```yaml
# Rasterwright image policy. Commit this file; `check` and `fix` both read it.
#
# Byte sizes are 1024-based, matching what your file browser shows you:
# 500kb is 512000 bytes and 1mb is 1048576. A plain number is bytes.
#
# Generated by `rasterwright init` from the 76 images it found
# in this repository. The numbers below describe what is already here,
# rounded up so most of it passes today. Edit them to describe what you want.

version: 1

defaults:
  upscale: false # Rasterwright never enlarges an image.
  stripMetadata: true # Drop EXIF/XMP/IPTC when a file is rewritten. ICC is kept.
  autoOrient: true # Normalize a non-normal EXIF orientation flag.
  colorSpace: srgb # Only srgb is supported.

rules:
  # 75 images. Widths up to 2560 (90th percentile 1437); sizes up to 731 KB (95th percentile 227 KB).
  "assets/src/images/**/*.{jpg,jpeg,png,webp}":
    maxWidth: 2000
    maxBytes: 300kb
    # maxHeight: 2000
    # format: webp # renames files; `fix` then needs --allow-renames
```

### Where the numbers come from

The scan is the same read-only discovery and inspection `check` performs.
Nothing about `init` opens an image for writing.

1. **Group by directory.** Every directory holding images becomes a candidate,
   and a directory absorbs everything beneath it. Images sitting at the project
   root get a non-recursive glob, so one stray screenshot cannot produce a rule
   that governs the whole tree.
2. **Drop the noise.** A group of fewer than three images is not evidence of
   anything, and is left ungoverned rather than turned into a rule.
3. **Merge down to three rules.** While more than three groups remain, the
   deepest one is rolled up into its parent. A roll-up that reaches the project
   root collapses to a single broad rule.
4. **Round up a ladder.** `maxWidth` is the 90th percentile of displayed widths
   and `maxBytes` the 95th percentile of file sizes, each rounded up to the next
   round number: 640, 800, 1000, 1200, 1600, 2000, 2400, 3000, 4000 pixels, and
   50kb through 5mb. A generated limit should read as a decision, not as a
   measurement of whatever happened to be on disk that day.
5. **Loosen until it is a starting point.** The candidate policy is then run
   through the real evaluator, and each rule climbs its ladder until at most
   `max(3, 5%)` of the images it governs are over a limit.

Bytes get the looser percentile because an image corpus is usually bimodal: a
pile of small icons and a handful of photographs. The 90th percentile of bytes
lands between the two humps and produces a config that flags every photograph on
the day it is written, which is a config you delete rather than edit.

Only dimension and byte findings drive step 5. An extension that disagrees with
its contents, or a stray EXIF block, is a real finding that no ceiling can move,
and reacting to one would loosen the policy for a reason unrelated to size.

### The generated globs match what was measured

Two details that only show up in awkward repositories, both of which would
otherwise produce a confident-looking config that governs nothing.

A directory can be called `img (old)` or `[drafts]`, and those characters are
glob syntax. `init` escapes them, and writes globs as single-quoted YAML so the
escaping survives the file. A name containing a quote or a backslash works too.

Extensions are discovered case-insensitively but matched case-sensitively
everywhere except Windows, so a repository holding `hero.JPG` gets an extension
group that includes `JPG`. Only spellings actually present are added, so an
ordinary repository keeps the short `*.{jpg,jpeg,png,webp}`.

### The violation count is exact, not an estimate

`init` reports what `check` will say, because it runs the same evaluator over
the same `ImageInfo` it already gathered. In the run above, `check` then reports
five errors and twenty-four warnings, and it is worth knowing that before you
run it rather than after.

A generated policy is not a clean slate and is not meant to be. Three files over
a limit is the tool telling you where the outliers are.

### What `init` never writes

No `format`, and no `maxHeight`. `format` renames files, needs
`--allow-renames`, is unsafe over transparency, and is a judgement call a
heuristic has no standing to make on your behalf. Both appear as commented
examples instead, next to the numbers they would sit beside.

`init` writes exactly one file, the config, plus one appended block in
`.gitignore` inside a git work tree. It creates no directories and no
`.rasterwright/`. It refuses rather than overwrite an existing config, and
refuses to write `.rasterwright.yaml` beside an existing `.rasterwright.yml`,
because Rasterwright loads the `.yml` first and nothing would ever read the
file it had just written. The other direction is allowed and says so: a new
`.rasterwright.yml` takes precedence over an existing `.rasterwright.yaml`.

### `.gitignore`

Inside a git work tree, `init` asks `git check-ignore` whether `.rasterwright/`
is already ignored. If it is not, it appends one comment and one line:

```
# Rasterwright's working directory (review pages, copies of originals).
.rasterwright/
```

This is the one place Rasterwright edits a file you did not ask it to create.
`fix` never does; it prints a suggestion and stops. `init` does it because
generating project configuration is exactly what was asked for, and because
`review` will write that directory whether or not anybody acted on a hint.

The decision is delegated to git rather than to a string search, so a nested
`.gitignore`, a negation, `.git/info/exclude` or your global excludes all count,
and a second `init` is a no-op. The append reuses the file's own line endings,
so a CRLF `.gitignore` stays CRLF and the diff is two lines rather than the
whole file. `--keep-gitignore` opts out entirely. Outside a git work tree,
nothing is written and the summary says so.

Note that `--no-gitignore` means something else here, the same thing it means
everywhere: scan git-ignored images too, rather than skipping them.

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

A file that could not be read or decoded carries an extra `error` key holding
the decoder's message, and has no `image` and no `policy`. That is the JSON side
of the `decode` check.

```json
{
  "path": "assets/truncated.jpg",
  "status": "error",
  "matchedGlobs": ["assets/**/*.{jpg,jpeg,png,webp}"],
  "findings": [{ "check": "decode", "severity": "error", "fixable": "no" }],
  "fixable": "no",
  "error": "Input buffer contains unsupported image format"
}
```

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
```

Everything below describes the plan. What happens when that plan is executed is
[`rasterwright fix`](#rasterwright-fix), further down.

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

### How a byte budget is actually met

`fix` enforces `maxBytes` during execution, in memory, before anything is
written:

1. Encode at `quality.start`. If the result fits, that is the answer, and
   exactly one encode happened.
2. Otherwise binary-search the whole integer quality range from `floor` to
   `start - 1`, keeping the **highest** quality whose measured output fits.
3. Never below `floor`, never above `start`, and never a second lever: the
   dimensions and the output format are the plan's, and the plan is fixed
   before any encoding begins.

Only a probe whose own bytes were measured under the ceiling is ever accepted,
so the search does not depend on smaller quality always meaning smaller output.
The widest band the config allows needs at most eight encodes.

PNG has no quality dial, so there is nothing to search. It gets one
maximum-effort lossless re-encode and either fits or does not.

A ceiling the search cannot reach is a failure, and the original is left exactly
as it was:

```
✗ assets/impossible/tiny.jpg

    encode        JPEG
    target        <= 20 KB
    quality       82 -> 40 (searched 40-81)
    failed        cannot reach 20 KB at 700x700 without dropping below quality 40
                  (best: 101 KB at quality 40). Raise maxBytes, lower maxWidth or
                  maxHeight, or allow webp for this glob.
```

The three remedies are manual on purpose. Dropping further would mean encoding
below a floor the policy set; changing the dimensions or the format on its own
would make the output depend on encoder results, which is exactly what
`fix --dry-run` promises never to happen. See `04-v0-technical-plan.md` section
19.

Under `--json`, each result carries what the encoder did:

```json
"encode": {
  "format": "jpeg",
  "bytes": 201971,
  "quality": { "start": 82, "chosen": 72, "floor": 40, "searched": true, "attempts": 6 }
}
```

It is present on failures too, because the quality the search reached and the
smallest output it produced are the actionable half of the report. The shape is
not a stable API yet.

One consequence worth knowing: a rule that sets `maxBytes` applies that ceiling
to **every** encode it governs, not only the ones the budget caused. A file
being rewritten for some other reason under such a rule is also searched if the
start quality overshoots, so it can land smaller than it would have.

### A conversion is judged where it lands

A format conversion renames the file, and the new path can match a different
rule. The ceiling the encode has to meet, and the quality band it searches, come
from **the rule governing the output path** - not from the rule that matched the
file you started with. That is the rule the result is verified against, so
optimizing for anything else would either report a reachable ceiling as
unfixable or chase a budget nothing checks.

```yaml
rules:
  "assets/*.png":
    format: webp        # says what the file must become
  "assets/*.webp":
    maxBytes: 100kb     # says what the output must satisfy
```

`assets/logo.png` is encoded as WebP and searched down until it fits 100 KB. The
plan says where the number came from:

```
    note          the 100 KB ceiling comes from assets/*.webp, which governs
                  the file after the rename, not from the rule matching it now
```

The source rule still decides `format`, `colorSpace`, `stripMetadata` and
`autoOrient` - what the file must *become*. Size limits take the tighter of the
two rules, so the output is compliant at both ends of the move. A target path
matching no rule has no ceiling at all, and the plan says that too.

One thing a destination rule can never do is turn a rename into a re-encode. A
limit only the destination imposes rides along with a rewrite that is already
happening; correcting a filename never spends generation loss on the pixels.

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

## `rasterwright fix`

Without `--dry-run`, `fix` executes the plan it just printed. It plans through
exactly the same read-only pipeline, so what runs is what the dry run described.

```
$ rasterwright fix --allow-renames
rasterwright: assets/hero.jpg has uncommitted changes, which are the one thing git
cannot restore; commit or stash them first

Rasterwright Fix

SKIPPED

⊘ assets/icons/logo.png

    skipped       transparency present, and JPEG cannot represent it

FIXED

✓ assets/heavy.jpg

    encode        JPEG
    target        <= 200 KB
    quality       82 -> 72 (searched 40-81)
    re-encode     lossy source re-encoded; some generation loss
    size          457 KB -> 197 KB  (57% smaller)

✓ assets/heroes/hero.jpg

    encode        WebP
    ceiling       <= 100 KB
    quality       82
    re-encode     lossy source re-encoded; some generation loss
    rename        .jpg -> .webp
    path          assets/heroes/hero.webp
    size          1.0 KB -> 512 B  (51% smaller)

✓ assets/oversized.jpg

    resize        2000x1200 -> 1200x720
    encode        JPEG
    ceiling       <= 200 KB
    quality       82
    re-encode     lossy source re-encoded; some generation loss
    size          7.2 KB -> 2.8 KB  (61% smaller)

15 images inspected
6 files fixed
1 file skipped
2 warning-only files left unchanged
6 already compliant
469 KB -> 203 KB across the files that changed (266 KB saved)
1 image matched no rule and was skipped
```

Exceptions come first - failed, then skipped, then blocked - because those are
the only part of the report anyone has to act on. The fixed files are already
correct.

### What actually executes

| Operation | Executes today |
|---|---|
| `autoOrient` | Yes. Pixels rotated, flag cleared. |
| `resize` | Yes. Down only, `fit: inside`. |
| `toColorSpace` | Yes, via an ICC transform to sRGB. |
| `encode` | Yes. Once when the output fits at `quality.start`, otherwise a downward search. |
| `rename` | Yes, with `--allow-renames`. |

Every one of them is enforced, byte budgets included. A candidate that comes out
over its ceiling after the search has run is `failed`, and the original is left
exactly as it was.

This is why the `quality` row reads differently in the two reports. The plan
says `82, searched down to 40 if needed`, describing a band it *would* search.
The run says `82 -> 72 (searched 40-81)` when it searched, and a bare `82` when
the start quality fit and no search happened.

### A file that changes mid-run is refused

The plan describes the file `check` inspected. If the bytes on disk are no
longer those bytes when the executor reaches them, every decision in the plan
was made about a file that no longer exists, and rendering the new bytes through
the old plan would overwrite somebody's edit with a resize computed for a
different image. `check` already hashed what it read, so this costs one
comparison: the file is `failed` with "the file changed on disk after this run
planned it", and rerunning picks up the new contents.

### Nothing is overwritten before it has been verified

For every file, in this order:

1. the whole output is rendered into a Buffer in memory;
2. it is inspected by the same inspector `check` uses, labelled with the path it
   is going to live at;
3. it is evaluated against the effective policy of *that* path, because a rename
   can move a file out from under the rule that governed it;
4. only then is anything opened for writing.

A candidate that still breaks a rule is a `failed` file, not a written one. Two
further assertions the policy language cannot express are checked as well: the
encoder must have produced the format the plan named, and an encode required to
preserve transparency must have preserved it.

Writes are a temp file in the same directory, an fsync, and an atomic rename,
with the parent directory fsynced afterwards. A reader never observes a
half-written image. On a format conversion the new path is created first and the
old one unlinked second, so a crash between them leaves both files rather than
neither. File mode is preserved; mtime deliberately is not.

### Preconditions, checked before anything is written

**Git is the undo mechanism.** `fix` overwrites tracked files in place and
relies on `git checkout --` rather than keeping a parallel set of backups.

- **Inside a repository:** it proceeds, and warns per file that git has no
  stored copy of. A modified file needs a commit or a stash, an untracked one
  needs `git add`, an ignored one needs `git add -f`. Warnings only. They never
  block a file and never change the exit code.
- **Outside a repository, or when git cannot answer:** it refuses with exit `2`
  and writes nothing at all, unless you pass `--no-git` (accept that there is no
  undo) or `--backup-dir <path>`.

`--backup-dir` copies each original to `<dir>/<its repo-relative path>`
immediately before overwriting it, and satisfies the precondition above. The
directory must be outside the project, because one inside it would be walked by
the next scan and governed by the project's own rules. An existing backup of the
same bytes is fine, so a rerun works; one holding *different* bytes fails that
file rather than replacing what may be the only surviving original.

After the preconditions pass, and only then, the run recovers any image an
interrupted rename left under an interim name and sweeps any stale
`.rasterwright-tmp-*` file whose owning process is gone - in the directories it
is about to write to, and nowhere else. Both are reported on stderr.

### Ctrl+C

The first `SIGINT` sets a stop flag. Files already in flight finish their atomic
write; every file after them is `skipped`. Nothing is left half-written, no temp
file survives, and the run prints what it got through:

```
Interrupted after 7 of 15 files; 3 fixed.
Nothing was left half-written. Rerun the same command to continue.
```

Exit code `1`. A second `SIGINT` exits immediately. Rerunning is the whole
resume mechanism: a compliant file produces no plan, so a second run picks up
exactly where the first stopped.

### Idempotence

A second `fix` over the same project writes **zero bytes**. Not "produces the
same result" - opens nothing for writing at all. The file's current state is the
only source of truth, there is no hidden provenance metadata in any image, and a
compliant file produces no findings, no findings produce no plan, and an empty
plan changes nothing.

### `rasterwright fix --json`

The report goes to stdout and every diagnostic to stderr, so the output stays
parseable. On top of the plan fields:

```jsonc
{
  "runId": "0f5f2b1e-...",              // identifies this run
  "engine": { "sharp": "0.35.4", "vips": "8.17.1" },
  "dryRun": false,
  "permissions": { "allowRenames": true },
  "summary": {
    "checked": 15, "fixed": 5, "unchanged": 8, "unchangedWithWarnings": 2,
    "skipped": 2, "blocked": 0, "failed": 0,
    "bytesBefore": 565248, "bytesAfter": 132096,  // over the files that changed
    "interrupted": false, "completed": 15, "ignored": 1
  },
  "results": [                          // every file that is not `unchanged`
    {
      "path": "assets/heroes/hero.jpg",
      "outputPath": "assets/heroes/hero.webp",
      "status": "fixed",                // fixed | skipped | blocked | failed
      "applied": ["encode", "rename"],
      "before": { "bytes": 143565, "width": 600, "height": 400, "format": "jpeg" },
      "after":  { "bytes": 41984,  "width": 600, "height": 400, "format": "webp",
                  "contentHash": "9c2a..." },
      "encode": { },                    // what the encoder did; see above
      "savingsPct": 70.7,
      "beforeFile": "before/9c2a....jpg",  // the retained original, if one was kept
      "reason": "...",                  // why it failed, was skipped or was blocked
      "warnings": [],                   // error-level findings still outstanding
      "needsAttention": false,
      "plan": { }                       // the plan, exactly as --dry-run reports it
    }
  ],
  "unrecovered": [],                    // images stranded under an interim name
  "reviewRecorded": true,               // this run appended itself to the manifest
  "diagnostics": []
}
```

`beforeFile` is present only on a `fixed` result from a run that was keeping
review data, and is relative to `.rasterwright/review/`. `reason` is present
only on a result that failed, was skipped or was blocked. `reviewRecorded` is
`false` under `--no-review` and `false` for a run that wrote no file at all,
which is what keeps an idempotent second run from pruning away the run that
actually changed something.

`needsAttention` is what the exit code reads per file, but it is not the whole
of it: the run exits `1` when `needsAttention` is set on any result, when
`unrecovered` is non-empty, or when the run was interrupted. `unrecovered` is
the one to watch: each entry is an image an interrupted rename left under an
interim name that this run could not put back, and it is never deleted.

A `fixed` result can still set `needsAttention`, which is why a successful run
can exit `1`. It happens on a pixel-free rename: correcting `logo.png` to
`logo.webp` touches nothing about a file that was also too wide, so
verification lets those findings through into `warnings` rather than failing a
write that was correct. The rename succeeded and the file is still not
compliant, so the run says both.

### Result statuses

| Status | Meaning |
|---|---|
| `fixed` | A verified candidate replaced the original. |
| `unchanged` | Nothing to do. Counted in the summary, omitted from `results`. |
| `skipped` | A plan exists and this run will not execute it: it needs a permission, is unsupported, or is unfixable. |
| `blocked` | Batch preflight refused the plan's output path. |
| `failed` | Execution or verification failed, or the image could not be decoded. **The original is untouched.** |

## `rasterwright review`

Numbers do not tell you whether an image still looks right. `review` builds one
static HTML page from what the last `fix` run did and opens it in your browser.

```
$ rasterwright review
/home/you/project/.rasterwright/review/index.html

7 files across 1 retained run, 3 needing attention.
469 KB of retained originals. Delete them with `rasterwright review --clean` when you are done looking.
```

The page has three parts.

1. **A header** for each retained run: when it finished, how many files were
   fixed, skipped, blocked and failed, the bytes before and after, and the
   Rasterwright, Sharp and libvips versions that produced them.
2. **Needs attention, first.** Every file with something worth looking at, most
   urgent first. When there is nothing, it says so explicitly, which is itself
   the useful answer.
3. **All changes.** A card per written file that is not already above, with the
   before and after side by side, the dimensions, bytes, format and savings, and
   the ordered list of operations with the quality the encoder actually chose.

The two images in a card share one scale, so a file resized from 2000px to
1200px is drawn visibly smaller than the original beside it rather than blown
back up to fill an identical box. A PNG or a WebP sits over a checkerboard, so
transparency is visible rather than guessed at; a JPEG does not, because it
cannot hold any.

Click either image to zoom to natural pixels. The slider on a card overlays the
two so they line up exactly, at one scale, with a button for each pane so both
stay reachable at a full reveal. A checkbox hides everything but the exceptions,
and a filter box narrows by path; `/` jumps to it. All of that is a hundred
lines of vanilla JavaScript over markup that is already complete without it: the
page works with scripting disabled, makes no network requests, embeds no data
URIs, and loads nothing from a CDN.

### What counts as needing attention

| Flag | What it means |
|---|---|
| `failed` | Execution or verification failed. The original is untouched. |
| `blocked` | Batch preflight refused the output path. |
| `skipped` | A plan exists and the run did not execute it. |
| `unmet-budget` | A `maxBytes` ceiling the run could not reach. |
| `transparency` | Transparency is why Rasterwright refused. |
| `unresolved` | The write left an error-level finding outstanding. |
| `renamed` | The file is at a different path than it started at. |
| `grew` | The output is larger than the input. |
| `barely-shrank` | A lossy re-encode that saved under 2%: quality spent for nothing. |
| `shrank-suspiciously` | Over 95% smaller. Worth confirming with your eyes. |
| `quality-only-drop` | Over 70% smaller with no resize behind it. |
| `dimensions-without-resize` | The dimensions moved with no resize planned. |

### Where the before images come from

`fix` copies each original into `.rasterwright/review/before/<sha256>.<ext>`
immediately before it overwrites it - after the candidate has been verified, so
a file that failed is never copied. Content-hash naming means an unchanged file
is never copied twice and two runs cannot collide over a name.

Before any of that, `fix` checks that `.rasterwright`, `.rasterwright/review`
and `before/` are each either absent or a real directory, and refuses the whole
run with exit `2` if one of them is a file or a symlink. Refusing once, having
written nothing, beats failing image after image with the same errno.

A copy that cannot be written **fails that file**, and the original is left
exactly as it was. That is the same refusal `--backup-dir` makes one line above
it, and for the same reason: inside a repository git covers tracked, clean
files, but `fix` warns per file precisely because untracked, ignored and
modified ones have no stored copy at all. For those the before-copy is the only
record of what the original looked like.

`fix --no-review` turns the whole mechanism off: no copies, no manifest, no
`.rasterwright/` directory. Use it on a tree that genuinely cannot hold one.

### Retention

One run is kept by default. `review --keep <n>` raises that and **persists it**
in the manifest, so the next `fix` keeps `n` runs rather than pruning straight
back to one. Copies no retained run refers to are deleted, and only names
matching `<64 hex>.<jpg|jpeg|png|webp>` are ever candidates - anything else you
put in that directory is left strictly alone.

`review --clean` deletes `.rasterwright/review/` outright, retained originals
included. It never touches `.rasterwright/` itself, and it refuses to run
alongside `--keep`, which asks for the opposite thing.

A second, idempotent `fix` records nothing and leaves the directory
byte-identical. The test is whether the run actually *wrote* a file, not whether
it had anything to report: a project with a permanently unfixable file reports
that file on every run, and recording those would prune away the run that
changed something.

### A page that has gone stale

Each written entry records the hash of the bytes the run produced, so a page
rendered days later can tell you which of three things is true about a file: it
is what the run produced, it has changed since, or it is gone. You get a note on
the card saying which, rather than a later edit presented as Rasterwright's work.

### `.rasterwright/` and git

After a run that recorded something, `fix` asks git whether `.rasterwright/` is
ignored. If it is not, you get one line on stderr suggesting you add it. That is
all it does: **`fix` never edits your `.gitignore`.** Editing a file you keep
under version control, as a side effect of an image fix, would turn up
unexplained in your next `git diff`. `init` does write that line, because
generating the config is what you asked it to do. See
[`rasterwright init`](#rasterwright-init).

`review` exits `0` when it renders a page and `0` when there is nothing to
render, because a project where `fix` has never run is not a project with a
problem. It exits `2` on a configuration or runtime failure, and there is no
exit `1`: it reports what an earlier run did, and that run already had its say
about the exit code.

## Exit codes

One model, every command. Warnings never produce a non-zero exit.

| Code | `check` | `fix --dry-run` | `fix` |
|---|---|---|---|
| `0` | No error-level findings. | Every error is covered by a plan this run could execute (or there are none). | Nothing needs attention, and the run was not interrupted. |
| `1` | At least one error. | At least one file is left unresolved: waiting on permission, blocked by a path conflict, unfixable, or unsupported. | A file failed, was skipped or was blocked; a file was fixed and still carries error-level findings the fix could not touch; an image is stranded under an interim name; or the run was interrupted. |
| `2` | Configuration or runtime error. Nothing was checked. | Same. | Same, plus a refused precondition: outside a git repository without `--no-git`, or an unusable `--backup-dir`. Nothing was written. |

`rasterwright review` and `rasterwright init` are not in that table on purpose:
neither ever exits `1`. `review` reports what an earlier run did, and that run
already had its say. `init` exits `0` when it wrote a config, even one that
already flags files, and `2` when it wrote nothing: the config exists and
`--force` was not passed, the target directory does not exist, or the scan
failed.

An interrupted run exits `1`, not `130`. Three codes with one meaning each is
worth more than agreeing with the shell convention for a signal. A usage error -
an unknown flag, a stray positional argument, a fractional `--concurrency` - is
also a `2`, because nothing was checked.

### `--json` on an exit `2`

A run that asked for JSON gets JSON, including when it fails before it can
produce a report. Stdout carries one document and stderr carries the human
message:

```json
{
  "rasterwrightVersion": "0.1.0",
  "error": "/path/to/project is not inside a git repository, so an overwrite could not be undone",
  "exitCode": 2
}
```

Deliberately not a report with zero files. Nothing was checked, and a document
saying "0 errors" would be a lie in exactly the situation where being believed
matters most.

An unreadable image is an exit `1`, not a `0`: it is a file that is supposed to
be governed and is not being governed. The rest of the batch still runs.

So `fix --dry-run` exiting `0` means "Rasterwright has a complete plan it could
execute", which is the useful thing to gate automation on.

## Options

```
rasterwright [options] [command]

  -V, --version        output the version number
  -h, --help           display help for command

rasterwright init [options]

  -c, --config <path>  where to write the config (default: .rasterwright.yml here)
  --bare               write the commented template without scanning anything
  -f, --force          overwrite an existing config
  --keep-gitignore     do not add .rasterwright/ to .gitignore
  --no-gitignore       do not skip git-ignored files while scanning
  --concurrency <n>    number of images to inspect in parallel

rasterwright check [options]

  -c, --config <path>  path to .rasterwright.yml (default: nearest one, searching upwards)
  --json               emit machine-readable JSON on stdout instead of a report
  -v, --verbose        list every warning and note individually instead of summarizing
  --no-gitignore       do not skip git-ignored files
  --concurrency <n>    number of images to inspect in parallel

rasterwright fix [options]

  -c, --config <path>  path to .rasterwright.yml (default: nearest one, searching upwards)
  --dry-run            report what fix would do, and write nothing
  --allow-renames      permit operations that change a filename (format conversion,
                       extension correction)
  --json               emit machine-readable JSON on stdout instead of a report
  --no-gitignore       do not skip git-ignored files
  --no-git             run outside a git repository, accepting that overwrites cannot be undone
  --backup-dir <path>  copy every original into this directory before overwriting it
  --no-review          do not keep before-copies or record this run for `rasterwright review`
  --concurrency <n>    number of images to process in parallel

rasterwright review [options]

  -c, --config <path>  path to .rasterwright.yml (default: nearest one, searching upwards)
  --keep <n>           retain this many runs from now on, and prune to it
  --clean              delete .rasterwright/review/ and its retained originals
  --no-open            print the path to the page instead of opening a browser
```

`-h, --help` also works on every subcommand, and both it and `-V, --version`
exit `0`.

Reach for `--dry-run` first. It is the same planning pass, printed instead of
performed.

## Planned

Clearly labelled as **not built**:

- **PNG palette support.** An indexed PNG is re-encoded truecolour today and can
  come out several times its original size, and a byte budget on one has no
  answer beyond the explicit failure. `palette: true` is lossless only while the
  colour count is unchanged, which nothing in the metadata guarantees, so it
  needs a raw-pixel equality check and a phase of its own. See
  `04-v0-technical-plan.md` section 19.
- **Extra downscale and format fallback under a byte budget.** Stepping the
  dimensions down, or converting to another format, when the quality floor is
  not enough. Both are new policy surface rather than new execution behaviour,
  and both would make the output dimensions or the output path depend on
  encoding results, which `fix --dry-run` promises they never do. The failure
  message names them as manual remedies instead.
- **A contact sheet for agent vision.** One labelled before/after PNG a model
  can look at, rather than a page a person opens. Cheap to add and worth adding
  if agents start reviewing runs. See `04-v0-technical-plan.md` section 12.
- **`review --from HEAD`.** Comparing against git's stored copy instead of
  against a retained one. Useful, and not a replacement for the copies: it
  cannot answer for an untracked file, a staged-but-uncommitted state, or a
  project outside a repository.

Deferred, with the reasoning recorded in `04-v0-technical-plan.md` section 14:
a `preferredFormat` distinct from a hard `format` requirement, a `--strict`
mode that promotes unknown colour space to an error, and any caching.

Deliberately out of scope: any GUI, any chatbot, any model inference, an MCP
server, a plugin system, accounts, telemetry, and a hosted anything.

## Development

```bash
npm install          # install dependencies, then build (via the prepare script)
npm test             # vitest, generates image fixtures automatically
npm run typecheck    # tsc --noEmit over src, tests and scripts
npm run build        # compile to dist/
npm run fixtures     # regenerate fixtures/images and fixture projects
npm pack             # build, then write rasterwright-0.1.0.tgz for a local install
npm run rasterwright -- check --config <path>   # run from source
```

The published tarball carries `dist/`, `skills/`, `README.md` and `LICENSE`, and
no source maps. The package stays `private: true` so a stray `npm publish`
cannot succeed; `npm pack` and `npm install <tarball>` both work regardless.

### Layout

```
src/
  cli/         commander wiring, exit codes, human and JSON renderers
  config/      load, validate and resolve .rasterwright.yml
  scanner/     file discovery and Sharp-based inspection
  policy/      pure functions: ImageInfo + rule -> findings
  operations/  planning (pure), plus the pipeline, atomic writer and executor
  review/      the before-copy store, the manifest, the page, the browser opener
  init/        the scan, the grouping heuristic, the templates, the gitignore edit
  utils/       byte parsing, hashing, ICC reading, paths, concurrency, signals
  run-check.ts   the read-only check pipeline
  run-fix.ts     check's pipeline, plus planning (read-only) and execution
  run-review.ts  the manifest, staleness detection and the rendered page
  run-init.ts    the read-only scan and the config text it produces
```

The architecture is `policy -> analysis -> operation plan -> execution ->
verification`, and every stage of it now exists. The layering is what keeps the
guarantees provable rather than merely intended:

- `policy/` and `operations/plan.ts` are pure functions over plain data. The
  planner reads nothing beyond the `FileResult` it is handed, calls no Sharp,
  and touches no filesystem, which is what makes plans deterministic and
  testable without a single image file.
- `operations/pipeline.ts` is bytes in, bytes out. No filesystem, no policy.
- `operations/atomic.ts` is the only module that writes image bytes, and nothing
  in it knows what an image is.
- `review/html.ts` and `review/classify.ts` are pure functions from a manifest to
  a string, so what the page says is testable without a browser or a filesystem.
- `init/heuristics.ts` and `init/template.ts` are pure functions over paths and
  `ImageInfo`, and `run-init.ts` writes nothing at all: `cli/init.ts` is the only
  thing in that command that opens a file for writing. The generated text is
  validated through the real config loader before it is written, not after.
- `check` and `fix --dry-run` import nothing that writes, which is what makes
  both read-only by construction rather than by discipline.

The CLI never calls Sharp directly.

Fixture images are generated by `scripts/generate-fixtures.ts` rather than
committed as binaries. They are real files produced by Sharp, deterministic, and
regenerated automatically before the test suite runs. The fixture projects'
`.rasterwright.yml` files are committed, because those are the part worth
reading in a diff.

Sharp is pinned to an exact version. Encoder behaviour will eventually determine
output bytes, and a floating range would make that non-reproducible.

## Licence

MIT.
