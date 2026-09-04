---
name: rasterwright
description: Check and fix image files against a repository's .rasterwright.yml image policy, using the rasterwright CLI. Use whenever an image under a repository that has a .rasterwright.yml is added, replaced or changed, or when the user asks to resize, convert, compress, optimize or strip metadata from images in such a repository.
---

# Rasterwright

Rasterwright governs the image assets committed to a repository. The policy
lives in `.rasterwright.yml`; every command finds it by looking upward from the
current directory, and the directory holding it is the project root every
printed path is relative to. If there is no `.rasterwright.yml` at or above the
images you are touching, this skill does not apply, and do not run
`rasterwright init` to create one unless the user asked for a policy.

## Running the CLI

Every command below is written as `rasterwright ...`. If that is not on `PATH`,
the project almost certainly has it as a dev dependency: use
`npx rasterwright ...` from inside the project, or `npm install -D rasterwright`
if `package.json` does not list it yet. Do not install it globally on the
user's behalf.

## The contract

Three rules, in order of how much damage breaking them does.

1. **Never edit `.rasterwright.yml` to make a finding go away.** The policy is
   the human's stated intent. Loosening a limit so `check` passes is the one
   change that makes the tool worthless. If a limit looks wrong, say so and let
   the human decide.
2. **Never write an ad-hoc sharp, ImageMagick, `convert`, `cwebp` or `ffmpeg`
   script for a governed image.** That improvised, non-idempotent workflow is
   exactly what Rasterwright exists to replace. Use the CLI.
3. **Never delete or move a file to clear a path collision.** Report it.

## Workflow

### 1. Read the state

```
rasterwright check --json
```

Exit `0` clean, `1` error-level findings exist, `2` nothing ran (a config or
runtime failure). With `--json`, stdout carries exactly one JSON document and
every diagnostic goes to stderr, so piping to a parser is safe. On exit `2` the
document is a failure envelope with `rasterwrightVersion`, `error` and
`exitCode`, not a report with zero files. That envelope is `CliFailure` in
`src/types.ts`: it is written by the CLI wrapper on the failure path, and
`exitCode` appears nowhere else in the output.

Top level: `rasterwrightVersion`, `clean`, `configPath`, `root`, `summary`,
`files`, `diagnostics`. `diagnostics` is attached by the CLI wrapper rather than
by the check itself - the same sentences stderr carried, repeated in the
document so a caller parsing stdout sees everything a human would have.

Each entry in `files` has `path`, `status`, `matchedGlobs`, `policy`, `image`,
`findings`, `fixable`, and an `error` string when the file could not be decoded.

Each entry in `findings` has `path`, `rule`, `check`, `severity`, `actual`,
`allowed`, `fixable` and `message`.

- `check` is one of `maxWidth`, `maxHeight`, `maxBytes`, `format`, `extension`,
  `colorSpace`, `orientation`, `decode`, `metadata`, `colorSpaceUnknown`,
  `animated`, `ruleGlobExcludesTargetFormat`.
- `severity` is `error`, `warning` or `info`. Act on `error`. Report `warning`
  to the human without acting on it. Ignore `info`.
- `fixable` is `yes`, `no`, `unknown` or `n/a`. `unknown` means the answer
  depends on encoding results that `check` deliberately does not produce, and
  `maxBytes` is the only check that lands there.

### 2. Read the plan

```
rasterwright fix --dry-run --json
```

This writes nothing at all: no bytes, no temp file, no cache, no rename.

Top level adds `dryRun`, `permissions`, `complete` and `conflicts`. `complete`
is `true` when every error-level finding is covered by a plan this run could
actually execute, and it is what the exit code is derived from.

Each entry in `files` has `path`, `targetPath`, `status`, `operations`,
`blockedOperations`, `resolves`, `unresolved`, `normalizedDuringRewrite`,
`warnings`, `requiresVerification`, `requiredPermissions`, `reasons`, `notes`.
`status` is one of `unchanged`, `planned`, `requires-permission`, `blocked`,
`unfixable`, `unsupported`.

Read the plan before running the real thing. Proceed when everything you care
about is `planned` and `conflicts` is empty.

### 3. Apply it

```
rasterwright fix
```

Preconditions, checked before anything is written: `fix` refuses with exit `2`
outside a git work tree unless given `--no-git` (accepting there is no undo) or
`--backup-dir <path>` (a directory outside the project).

Pass `--allow-renames` **only** when the human has explicitly said renames are
acceptable for this run. A rename can break a reference in source code and
Rasterwright does not rewrite those references. It is a per-run permission and
deliberately not a config key.

Each entry in `results` has `path`, `outputPath`, `status`, `plan`, `applied`,
`before`, `after`, `encode`, `savingsPct`, `beforeFile`, `reason`, `warnings`
and `needsAttention`. `status` is one of `fixed`, `unchanged`, `skipped`,
`blocked`, `failed`. Top level also carries `runId`, `engine`, `unrecovered` and
`reviewRecorded`.

`encode.quality` is the honest record of what the encoder did: `start`,
`chosen`, `floor`, `searched`, `attempts`. Quote `chosen` when reporting a
saving, because that is the quality the bytes were actually written at.

### 4. Verify

Run `rasterwright check` again. Expect exit `0`.

A second `rasterwright fix` must write zero files. If it writes anything, that
is an idempotence bug worth reporting to the human explicitly, not something to
work around.

### 5. Show the pixels when it matters

```
rasterwright review --no-open
```

This prints the path to a local before/after HTML page. Give that path to the
human and ask them to look, whenever a change could plausibly hurt how an image
looks: a large saving, a format conversion, a resize on anything with fine
detail or text. Do not judge image quality from JSON numbers.

## Handling each outcome

- **`failed`** - execution or verification failed and the original is
  byte-for-byte untouched. Report `reason` verbatim. A missed byte ceiling names
  its three manual remedies: raise `maxBytes`, lower `maxWidth` or `maxHeight`,
  or allow another format for that glob. All three are policy changes, so they
  are the human's call. Do not retry blindly and do not lower the policy.
- **`blocked`** - batch preflight refused because the output path collides. Find
  the matching entry in `conflicts` and report `message` and `with`. Ask the
  human how to resolve it.
- **`skipped`** - a plan exists and this run would not execute it. Read
  `requiredPermissions`, which is almost always `allowRenames`, or `reason` for
  an unsupported or unfixable file. Ask the human.
- **`unrecovered` non-empty** - an image is stranded under an interim name from
  an interrupted run. Stop and tell the human. Nothing deletes these.
- **`needsAttention` on a `fixed` result** - the write succeeded and left
  error-level findings behind, which happens on a pixel-free rename. Report
  `warnings`.
- **Unsupported images** - 16-bit sources and animated images are never
  re-encoded, because Sharp's encoders write 8 bits per channel and v0 does not
  handle frames. A rename touches no pixels, so an extension correction on one
  is still performed.

## When not to use this

- **Build-time responsive variants.** Rasterwright governs the source images you
  commit. Generating `@2x`, `srcset` sizes or thumbnails is the build system's
  job.
- **Creative editing.** Cropping, retouching, compositing, colour grading.
- **SVG, GIF and AVIF.** Rasterwright only handles JPEG, PNG and WebP. An SVG in
  a governed directory is invisible to it.
- **CMS media libraries.** Those images do not live in git and are handled at
  upload time.
