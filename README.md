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

`check` never modifies anything. That is enforced by an integration test that
snapshots the size, mode, mtime and content hash of every file in a project
before and after a run and asserts they are identical.

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
| `format` | Preferred format: `jpeg` (or `jpg`), `png`, `webp`. A different current format is a violation. |
| `stripMetadata` | Default `true`. Reports EXIF, XMP and ICC profiles as violations. |
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
`format: webp` from the second rule, and keeps nothing from the first rule that
the second one overrode. A rule setting only `format` would leave the earlier
`maxWidth` intact.

Specificity is deliberately not considered. File order is the only thing that
decides, because that is the only rule that is easy to predict by reading.

Globs match repo-relative POSIX paths, case-insensitively.

### What gets checked

Rasterwright discovers `.jpg`, `.jpeg`, `.png` and `.webp` files under the
project root and always skips `.git/`, `node_modules/`, `.rasterwright/` and
hidden directories.

Git-ignored files are skipped too. That is implemented by asking
`git check-ignore`, which gets nested `.gitignore` files, negations and global
excludes exactly right for free. Outside a git work tree, or when git is
unavailable, the filter cannot run: Rasterwright then checks everything it
found and says so on stderr. `--no-gitignore` disables the filter deliberately.

**A file matched by no rule is silently skipped.** It is counted in the summary
and is not an error.

## `rasterwright check`

```
$ rasterwright check
Rasterwright

✗ assets/heavy.jpg

    maxBytes    457 KB            allowed: 200 KB

    1 violation
    Fixable: unknown (depends on encoding)

✗ assets/icons/logo.png

    format      PNG               expected: JPEG
        PNG, expected JPEG; cannot convert safely: transparency present, and JPEG cannot represent it
    note: image has meaningful transparency

    1 violation
    Fixable: no

✗ assets/oversized.jpg

    maxWidth    2000 px           allowed: 1200 px

    1 violation
    Fixable: yes

9 images checked
6 files with violations
3 compliant
1 image matched no rule and was skipped
```

### Checks

| Check | What it reports |
|---|---|
| `maxWidth` / `maxHeight` | Displayed dimensions exceed the limit. Displayed means after the EXIF orientation flag is applied, because that is what a browser lays out. |
| `maxBytes` | File size exceeds the ceiling. |
| `format` | Current format differs from the preferred one. |
| `metadata` | EXIF, XMP or an ICC profile is present while `stripMetadata` is on. |
| `colorSpace` | The image is confidently not sRGB. |
| `orientation` | A non-normal EXIF orientation flag. Always checked; there is no config key for it in v0. |

### Fixability

Each file reports whether a future `fix` could resolve everything:

- **yes** - a deterministic transform resolves every violation.
- **no** - at least one violation cannot be resolved safely. The common case is
  a transparent image under a `format: jpeg` rule: JPEG cannot represent an
  alpha channel, and Rasterwright will not guess a background colour.
- **unknown** - nothing is blocking, but at least one violation is `maxBytes`,
  and whether a byte ceiling can be met depends on what the encoder produces.
  `check` is read-only, so it deliberately does not find out.

### Things Rasterwright will not claim to know

- **Colour space is three-valued.** Confidently sRGB, confidently not sRGB, or
  unknown. An image carrying an ICC profile Rasterwright cannot identify is
  reported as a note, never as a violation - a false positive here would train
  you to ignore the tool. It is also not silently counted as compliant.
- **Transparency is measured, not assumed.** An alpha channel whose every pixel
  is opaque carries no information and does not block a JPEG conversion. When
  opacity could not be determined, Rasterwright assumes transparency, because
  the failure mode of guessing wrong is a black box where a logo used to be.
- **Metadata detection is honest.** Rasterwright reports what Sharp exposes -
  EXIF, XMP, ICC - and does not pretend to inventory every ancillary chunk.

## `rasterwright check --json`

For scripts and coding agents. stdout carries JSON and nothing else;
diagnostics go to stderr.

```json
{
  "rasterwrightVersion": "0.1.0",
  "clean": false,
  "configPath": "/repo/.rasterwright.yml",
  "root": "/repo",
  "summary": {
    "checked": 9,
    "compliant": 3,
    "violating": 6,
    "violations": 7,
    "errors": 0,
    "ignored": 1
  },
  "files": [
    {
      "path": "assets/oversized.jpg",
      "status": "violating",
      "image": {
        "path": "assets/oversized.jpg",
        "bytes": 7359,
        "format": "jpeg",
        "width": 2000,
        "height": 1200,
        "storedWidth": 2000,
        "storedHeight": 1200,
        "hasAlpha": false,
        "isOpaque": null,
        "pixelColorSpace": "srgb",
        "colorSpaceStatus": "srgb",
        "hasIccProfile": false,
        "iccDescription": null,
        "hasExif": false,
        "hasXmp": false,
        "orientation": 1,
        "isAnimated": false,
        "contentHash": "1b1f..."
      },
      "policy": { "upscale": false, "stripMetadata": true, "colorSpace": "srgb", "maxWidth": 1200, "maxBytes": 204800 },
      "matchedGlobs": ["assets/**/*.{jpg,jpeg,png,webp}"],
      "violations": [
        {
          "path": "assets/oversized.jpg",
          "rule": "assets/**/*.{jpg,jpeg,png,webp}",
          "check": "maxWidth",
          "actual": 2000,
          "allowed": 1200,
          "fixable": "yes",
          "message": "2000 px wide, allowed 1200 px"
        }
      ],
      "notes": [],
      "fixable": "yes"
    }
  ],
  "diagnostics": []
}
```

Every checked file appears, compliant ones included, because "this file is
governed and passes" is useful to an agent about to add another image beside it.
Files matched by no rule do not appear; they are only counted in
`summary.ignored`. This shape is not a stable public API yet.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean. Every governed image satisfies policy. |
| `1` | Policy violations, or an image that could not be read. |
| `2` | Configuration or runtime error. Nothing was checked. |

An unreadable image is an exit `1`, not a `0`: it is a file that is supposed to
be governed and is not being governed. The rest of the batch still runs.

## Options

```
rasterwright check [options]

  -c, --config <path>  path to .rasterwright.yml (default: nearest one, searching upwards)
  --json               emit machine-readable JSON on stdout instead of a report
  --no-gitignore       do not skip git-ignored files
  --concurrency <n>    number of images to inspect in parallel
```

## Planned

Clearly labelled as **not built**:

- `rasterwright fix` - deterministic, idempotent fixes: auto-orient, downscale,
  strip metadata, normalise to sRGB, convert format, and search encoder quality
  downward to meet a byte ceiling. Format conversion renames files
  (`hero.png` -> `hero.webp`) and can break references in source code, so it
  will require explicit authorisation rather than happening by default.
- `rasterwright review` - a local static HTML before/after page.
- `rasterwright init` - a starter config generated from what a repo already
  contains.

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
  policy/     pure functions: ImageInfo + rule -> violations
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
