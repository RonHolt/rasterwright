# Rasterwright

**An image policy and verification tool for software projects.**

Rasterwright governs the image assets that live in a repository. You write down
what those images are allowed to be - maximum dimensions, a byte ceiling, a
preferred format, no EXIF, sRGB - and Rasterwright tells you which files break
the rules.

It is the ESLint-shaped layer for images: opinions about the source you commit,
not a replacement for your build system's asset pipeline.

## Status

**Early, personal, open-source. One command works today: `check`.**

This is a tool built because its author wanted to use it. It is not a product,
there is nothing to buy, and it makes no network calls, collects no telemetry
and has no accounts. Broader use is welcome; adoption is not a goal.

What exists right now:

| Command | Status |
|---|---|
| `rasterwright check` | Implemented, read-only |
| `rasterwright fix` | Not implemented |
| `rasterwright review` | Not implemented |
| `rasterwright init` | Not implemented |

`check` never modifies anything. That is enforced by integration tests that
snapshot the size, mode, mtime and content hash of every file in a project
before and after a run and assert they are identical.

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

# or, during development, from the rasterwright checkout
npm run rasterwright -- check --config /path/to/project/.rasterwright.yml
```

`check` resolves the project root from wherever the config file lives, so the
second form works from anywhere.

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
| `transparency` | info | The image has an alpha channel that is actually used. |
| `alphaUnused` | info | An alpha channel exists but every pixel is opaque. |
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
- **Transparency is measured, not assumed.** An alpha channel whose every pixel
  is opaque carries no information and does not block a JPEG conversion. When
  opacity could not be determined, Rasterwright assumes transparency, because
  the failure mode of guessing wrong is a black box where a logo used to be.
  An unused alpha channel is never a violation, and a future `fix` will not
  rewrite a file just to drop one.
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
references in source code, so `fix` will require explicit per-run authorization
(`--allow-renames`) before performing one. `check` reports them either way.

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
    2 EXIF
    1 XMP

    Run with --verbose to list them.

15 images checked
7 files with errors
3 files with warnings
6 clean
3 informational notes (--verbose to show)
1 image matched no rule and was skipped
```

`--verbose` expands the warning summary into one block per file and adds a
`NOTES` section with every informational finding. It does not change the exit
code.

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
    "infos": 3,
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
        },
        {
          "path": "assets/logo-webp.png",
          "rule": "(built-in)",
          "check": "transparency",
          "severity": "info",
          "actual": null,
          "allowed": null,
          "fixable": "n/a",
          "message": "has meaningful transparency"
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

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean. No error-level findings. Warnings and notes do not fail a run. |
| `1` | At least one error, including a governed image that could not be read. |
| `2` | Configuration or runtime error. Nothing was checked. |

An unreadable image is an exit `1`, not a `0`: it is a file that is supposed to
be governed and is not being governed. The rest of the batch still runs.

## Options

```
rasterwright check [options]

  -c, --config <path>  path to .rasterwright.yml (default: nearest one, searching upwards)
  --json               emit machine-readable JSON on stdout instead of a report
  -v, --verbose        list every warning and note individually instead of summarizing
  --no-gitignore       do not skip git-ignored files
  --concurrency <n>    number of images to inspect in parallel
```

## Planned

Clearly labelled as **not built**:

- `rasterwright fix` - deterministic, idempotent fixes: auto-orient, downscale,
  strip metadata, normalise to sRGB, convert format, and search encoder quality
  downward to meet a byte ceiling. Operations that rename a file will require
  `--allow-renames`; without it, `fix` skips the rename and reports why rather
  than failing the batch.
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
  cli/        commander wiring, exit codes, human and JSON renderers
  config/     load, validate and resolve .rasterwright.yml
  scanner/    file discovery and Sharp-based inspection
  policy/     pure functions: ImageInfo + rule -> findings
  utils/      byte parsing, hashing, ICC reading, paths, concurrency
  run-check.ts  the read-only pipeline the CLI calls
```

The architecture is `policy -> analysis -> operation plan -> execution ->
verification`. This build stops after analysis. The CLI never calls Sharp
directly, `policy/` is pure functions over plain data, and nothing on the check
path imports anything that writes - which is what makes `check` read-only by
construction rather than by discipline.

Fixture images are generated by `scripts/generate-fixtures.ts` rather than
committed as binaries. They are real files produced by Sharp, deterministic, and
regenerated automatically before the test suite runs. The fixture projects'
`.rasterwright.yml` files are committed, because those are the part worth
reading in a diff.

Sharp is pinned to an exact version. Encoder behaviour will eventually determine
output bytes, and a floating range would make that non-reproducible.

## Licence

MIT.
