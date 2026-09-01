# Rasterwright: Personal Project Scope

**Status:** Active scope definition for v0
**Date:** 2026-08-31
**Supersedes as direction:** the venture framing in `01-product-thesis.md`
**Informed by:** `02-adversarial-review.md`

> This document defines **what** the first useful Rasterwright is.
> `04-v0-technical-plan.md` defines **how** it gets built.
> Neither document assumes a company, a market, or a customer.

---

## 1. Purpose

### The itch

I occasionally need to manipulate images while working on software projects. The work is almost never creative. It is constraint satisfaction: "this hero is 4200 px and 3.1 MB, it needs to be at most 2400 px and under 400 KB, and it should be WebP."

Every available path is slightly wrong for that job:

- **Photoshop / GIMP** are overkill. They also require remembering a GUI workflow I use a few times a year, so each visit starts with relearning the app.
- **ImageMagick / sharp scripts** are powerful and correct, but require remembering obscure syntax (geometry strings, gravity, `-define jpeg:extent`, `fit` modes) that I look up every single time.
- **Coding agents** can generate the command or the script, and they do it well. But the workflow is improvised each time: guessed quality settings, a throwaway script, non-idempotent re-encodes on the second run, and a text summary instead of pixels. Verifying the result is awkward.
- **Build pipelines** (Gulp + Sharp, Vite plugins, framework image components) execute known transforms reliably at build time. They do not provide a project-level layer that says what source assets are *allowed* to be, checks it, fixes it, and shows me the difference.

The gap is not capability. libvips can already do every operation. The gap is that there is no reusable, project-level **policy / check / fix / review** layer for the images that live in a repository.

### What Rasterwright is

> **Rasterwright is an image policy and verification tool for software projects.**

Four commands:

```
rasterwright init     # write a starter .rasterwright.yml
rasterwright check    # report policy violations, never modify
rasterwright fix      # apply safe, deterministic, idempotent fixes
rasterwright review   # generate a local before/after HTML review
```

The goal is to make routine image hygiene **predictable, repeatable, visually reviewable, and easy for both humans and coding agents to invoke.**

### What this project is (and is not)

- This is a **personal open-source project**. It exists because I want to use it.
- Broader adoption is welcome but not required. If it ends up with 40 stars and I still use it weekly, it succeeded.
- Business opportunities may be reconsidered **later, based on actual usage**. Not before. There is no revenue work, no pricing page, no hosted tier, and no growth target in scope.
- It is **not** a Photoshop replacement and **not** an AI novelty. There is no chatbot, no generative editing, and no model inference in v0.

### What we keep from the adversarial review

`02-adversarial-review.md` argued the business case was weak and the scope was bloated. Taken as business advice, that verdict is now moot: we are not building a business. Taken as *engineering* advice, most of it survives and is adopted here:

- The repo-policy + check/fix/review slice is the genuinely useful part. Keep it, drop the rest.
- Idempotence and determinism are the properties agent-written scripts demonstrably lack. Make them core.
- A static HTML report delivers the visual review; a desktop app does not earn its cost.
- Ship a CLI. Do not ship an MCP server, a plugin system, or a natural-language layer.
- Explicit failure beats silent image degradation.

What we **decline** from the review:

- The demand for a single static native binary before writing any code. That was a distribution argument for a product competing for adoption. For a personal tool used by me and a small team, Node + Sharp is the faster path to something real. Revisit if and when distribution actually matters.
- The 90-day kill criteria and the interview program. Those were gates for a startup. The gate here is simpler: do I keep using it.
- Perceptual metrics (SSIMULACRA2 / DSSIM / Butteraugli) as a v0 requirement. Good idea, real value, but it is a quality-floor refinement on top of a byte-budget search that has to exist first. Deferred, not rejected.

---

## 2. Primary user

**Me, and the small dev team I work with:** a developer working with image assets inside a software repository.

Optimize v0 for:

- front-end and web development,
- custom themes and bespoke sites,
- static assets,
- `public/`, `assets/`, `static/` directories,
- project images committed to git.

**Do not optimize v0 for:**

- CMS media-library uploads (WordPress and friends already solve this at upload time, and those images do not live in git),
- designers,
- photographers,
- general creative editing,
- e-commerce catalogs at volume.

The user is assumed to have a terminal, a git repo, and at least one coding agent. That assumption removes a lot of work: no installer UX, no onboarding wizard, no GUI.

**Secondary user, deliberately designed for:** a coding agent operating in the same repo. Agents should be able to run `rasterwright check` before committing an image and read a machine-readable result. That is a CLI contract, not an integration.

---

## 3. Core workflow

### `rasterwright init`

Writes a starter `.rasterwright.yml` in the repo root.

- Refuses to overwrite an existing config unless `--force`.
- May scan the repo for image files and use what it finds to suggest defaults: the directories where images actually live, the formats in use, a `maxWidth` at roughly the 90th percentile of existing widths, a `maxBytes` that most files already satisfy.
- **Suggestions must be conservative.** A generated config that immediately reports 200 violations is a config the user deletes. Aim for a starting policy where most existing files pass and the obvious outliers do not.
- Writes a commented file so the user can see what else is available.
- v0 keeps this simple: one scan, a handful of heuristics, no interactive prompts. If the heuristics are annoying, `init --bare` writes a plain commented template.

### `rasterwright check`

Finds images governed by policy and reports violations.

**It must never modify files. Not the images, not the config, not a cache.** This is an absolute invariant, and it is what makes the command safe to put in a pre-commit hook or CI.

Checks under consideration for v0 (see section 5 for what actually ships):

- dimensions (`maxWidth`, `maxHeight`, and possibly `minWidth`)
- file size (`maxBytes`)
- image format (allowed formats, preferred format per glob)
- metadata (EXIF/XMP/ICC present when policy says strip)
- color space (non-sRGB when policy says sRGB)
- transparency (an alpha channel where the policy forbids one, or vice versa)
- orientation (a non-default EXIF orientation flag)

Output:

- a human-readable table: file, rule, actual vs. allowed, whether `fix` can resolve it
- `--json` for agents and scripts
- exit code `0` when clean, non-zero when violations exist, so it gates a hook or a CI job with no extra glue

### `rasterwright fix`

Applies safe, deterministic fixes where possible.

Operations in scope:

- auto-orient (apply the EXIF orientation flag, then clear it)
- resize down to policy dimensions
- never upscale
- convert format per policy
- strip metadata
- normalize to sRGB
- compress toward a target byte budget

**Core invariant:**

> Running `rasterwright fix` twice must result in **zero changes** on the second run.

Idempotence is a product principle, not an optimization. It is the single property that makes the tool safe to run habitually, safe to put in a hook, safe to hand to an agent, and safe to run on a dirty working tree. If `fix` is not idempotent, every other feature is untrustworthy. Every fix operation must be defined so that applying it to an already-compliant file is a no-op, and the tool must be able to tell "already compliant" from "needs work" without re-encoding to find out.

Corollary: `fix` must be **honest about what it cannot do**. If a file cannot satisfy the policy without unacceptable degradation (see byte-budget behavior in `04`), `fix` leaves the file alone and reports the failure. It never silently ships a mangled image to hit a number.

### `rasterwright review`

Generates a local visual review of what `fix` changed.

For v0 this is a static HTML file written into the project and opened in the system browser. No server, no build step, no framework.

It shows, per changed image:

- before / after images, side by side, at a size where artifacts are actually visible
- original and output dimensions
- original and output filesize
- original and output format
- percentage size savings
- which operations were applied, in order
- anything that warrants manual attention, sorted to the top

"Warrants manual attention" means: files where the byte budget could not be met, files where quality dropped below the configured floor, files where transparency handling had to make a judgment call, files that shrank suspiciously little or suspiciously much, and any file where an operation failed.

This surface matters. The original itch includes "visually awkward to verify." A tool that optimizes 130 images and prints "saved 61%" has not solved the itch. Seeing the pixels is half the point.

---

## 4. Policy file

`.rasterwright.yml`, committed to the repo. Direction:

```yaml
defaults:
  upscale: false
  stripMetadata: true
  colorSpace: srgb

rules:
  "assets/**/*.{jpg,jpeg,png}":
    maxWidth: 2400
    maxBytes: 500kb

  "assets/heroes/**":
    maxWidth: 2400
    maxBytes: 400kb
    format: webp
```

Design intent:

- Globs are keys. Familiar from `.eslintrc` overrides, `tsconfig` includes, and every tool developers already use.
- `defaults` applies everywhere; a matching rule overrides it.
- Human-writable and human-diffable. Someone should be able to read the file and predict what `check` will say.

**Do not over-design the schema.** Ambiguities to call out rather than solve now:

1. **Rule precedence when multiple globs match.** Options: last-match-wins, most-specific-wins, or merge-all-matches. Merging is the most useful and the hardest to explain. *Current lean: last matching rule wins for any given key, with `defaults` at the bottom of the stack; document it loudly.* Needs a real-world test before it is fixed.
2. **Whether `format: webp` means "convert everything" or "convert unless conversion is unsafe."** Transparency, animation, and already-optimal formats all complicate this. *Current lean: "convert unless unsafe," with the skip reported.*
3. **Units.** `500kb` vs `500KB` vs `512000`. Accept a permissive string parse, normalize internally to bytes. Decide whether `kb` means 1000 or 1024 and write it down (lean: 1024, matching what developers see in a file browser, but this must be stated in the file's comments because it is a coin flip either way).
4. **Ignore semantics.** Does Rasterwright respect `.gitignore`? Does it need its own `ignore:` list? *Current lean: always skip `.git`, `node_modules`, and anything git-ignored; add an explicit `ignore:` list only when that proves insufficient.*
5. **Per-file exceptions.** Some image genuinely needs to be 5 MB. There is no mechanism yet. Options: an `exceptions:` block in the config, a magic comment, or a sidecar file. *Deferred until it actually hurts.*
6. **Whether `check` should fail on files no rule matches.** *Lean: no. Silence for unmatched files. Opt in with `--strict` later if wanted.*

---

## 5. v0 supported operations

The smallest set that makes the tool worth running.

**Formats in:** JPEG, PNG, WebP
**Formats out:** JPEG, PNG, WebP

*(AVIF is deferred: encoding is slow, agent vision cannot read it, and nothing in the itch requires it. GIF, SVG, TIFF, HEIC, and RAW are out.)*

**Checks:**

- dimensions (`maxWidth`, `maxHeight`)
- filesize (`maxBytes`)
- format (allowed / preferred)
- metadata present
- color space
- transparency present

**Fixes:**

- auto-orient
- resize (down only)
- no-upscale enforcement
- format conversion
- metadata stripping
- color space normalization to sRGB
- transparency preservation (never flatten by accident)
- target-size compression via quality search

**Behavior:**

- `check` is read-only, always
- `--dry-run` on `fix`, showing exactly what would change
- idempotent `fix`
- `--json` output on `check` and `fix`
- static HTML `review` with before/after

That is the whole of v0. Anything not on this list is a later decision, not an oversight.

---

## 6. Explicit non-goals

Not in v0, and not on a roadmap:

- desktop GUI (any framework, any shell)
- embedded chatbot
- natural-language interface inside Rasterwright
- MCP server
- generative image editing
- background generation or removal
- smart / AI crops (unless a concrete, repeated need later justifies it)
- plugin system
- accounts, login, or identity of any kind
- cloud service or hosted anything
- team management, roles, approvals
- hosted AI or any model inference
- monetization work of any kind, including pricing pages and license keys
- Photoshop-like editing (layers, masks, brushes, filters)
- replacing project build systems
- responsive image / srcset generation already handled by frameworks (revisit only if a real project needs it and the framework does not provide it)

Additional non-goals worth naming:

- **No telemetry.** Not opt-in, not anonymous, none.
- **No auto-update, no network calls at runtime.** The tool touches the filesystem and nothing else.
- **No image database or index.** Filesystem plus config is the state.
- **No Windows-specific work in v0** beyond whatever Node gives for free. Fix it if it breaks, do not design for it.

---

## 7. Relationship to existing tooling

Rasterwright does **not** replace:

| Tool | What it keeps doing |
|---|---|
| **Gulp** | Running the project's build tasks, including image tasks |
| **Vite** | Bundling, dev server, build-time asset transforms |
| **Webpack** | Same |
| **Next / Nuxt / Astro image systems** | Request-time and build-time responsive delivery, srcset, format negotiation |
| **Sharp** | Doing the actual pixel work. Rasterwright *is* a Sharp caller |
| **ImageMagick** | Everything Rasterwright does not cover, and every one-off the user still wants to write |

The division of responsibility:

> **Rasterwright governs source assets and project expectations.
> Existing build and delivery tooling continues to do runtime and build-time transformation.**

The analogy:

> **ESLint does not replace Vite.
> Rasterwright should not replace the asset pipeline.**

ESLint has opinions about the source you commit. Vite decides what ships to the browser. They coexist because they answer different questions. Rasterwright answers "is this asset allowed in this repo, and if not, can it be made allowed" - not "what bytes does the user's browser receive."

Practical consequence: if a framework already generates responsive variants at build time, Rasterwright should not generate them too. It should make sure the source the framework consumes is sane.

---

## 8. Personal success criteria

No stars, no installs, no MRR. The tool works if:

1. **I voluntarily use it on real projects**, without reminding myself to.
2. **My teammate can understand and use it without me explaining it.** They read the config, run `check`, and it does what they expected.
3. **I stop writing one-off Sharp and ImageMagick commands** for the common jobs: resize down, convert to WebP, hit a size budget, strip EXIF.
4. **Coding agents reliably run Rasterwright** instead of inventing a new image-processing script, because `rasterwright check` is right there and returns structured output.
5. **`check` and `fix` are safe enough to run habitually** - safe enough that running `fix` on a whole repo is not a decision I think about.
6. **`review` actually helps me catch visual problems** at least once. If I never open it, or open it and learn nothing, that half of the tool is wrong and should be cut or redesigned.
7. **Second-run `fix` is boring.** It reports zero changes and I trust it without checking.

Failure looks like: I install it, use it twice, and go back to asking Claude Code to write a sharp script. That is a real possible outcome and worth noticing quickly.

---

## 9. Open questions

Unresolved. Captured rather than answered.

**Product**

1. Is `review` a separate command, or should `fix` offer `--review` and open the page automatically? Two commands is cleaner; one command is what I would actually type.
2. Should `fix` be scoped to git-changed files by default (`--staged`, `--changed`) rather than the whole repo? For a pre-commit hook that is clearly right. For a first sweep it is clearly wrong.
3. What does `check` do about images that are compliant but obviously wasteful - a 2400 px PNG photograph that would be 80% smaller as WebP but violates no rule? Warning tier, or silence?
4. Is the byte budget per-file or per-directory? Per-file is simple. "This gallery must total under 3 MB" is the question people actually have.
5. How should a genuine exception be recorded so it is not re-flagged forever?
6. Does anyone want `check` to run in CI, or is pre-commit and manual invocation enough for how my team actually works?
7. Is `.rasterwright.yml` the right filename, or should it be `rasterwright.config.yml` / `.rasterwrightrc`? Minor, but it is committed to other people's repos.
8. Should the tool have opinions it did not get from config - a built-in "web sane defaults" preset invoked with `--preset web`?

**Agent-facing**

9. What exactly does an agent need in `--json` output to make a good decision? A guess now; correct it after watching a real agent use it.
10. Does a `SKILL.md` in the repo actually change agent behavior enough to matter, or does the agent have to be told each time? Worth an experiment before investing in it.
11. Should `review` also emit an image an agent's vision can read (a labeled before/after contact sheet), or is JSON enough? The adversarial review argued this is the genuinely unbuilt piece. It is also easy to add later.

**Scope pressure**

12. AVIF: how long before not supporting it is annoying?
13. SVG: it lives in the same directories and violates nothing Rasterwright checks. Does that feel like a hole?
14. At what point does "no responsive variants" become the thing that stops me from using it on a real project?

---

## 10. Definition of done for v0

v0 is finished when, on a real project of mine:

- `rasterwright init` produces a config I do not immediately have to rewrite,
- `rasterwright check` finds the violations I already knew about and none I disagree with,
- `rasterwright fix` fixes them without damaging anything,
- `rasterwright check` then passes,
- `rasterwright fix` again changes zero files,
- `rasterwright review` shows me the before/after and I actually look at it,
- and I commit the result without opening a single image in another application.

Next document: `04-v0-technical-plan.md`.
