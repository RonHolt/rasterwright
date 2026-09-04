# Rasterwright Adversarial Review

**Status:** Phase A/B output of the validation plan in `01-product-thesis.md`
**Date:** 2026-08-31
**Inputs:** `01-product-thesis.md` plus seven parallel research passes (libraries/CLIs/OSS, cloud media platforms, creative incumbents, AI assistants and coding agents, MCP servers and agent skills, CI/build/IDE tooling and problem frequency, desktop utilities and monetization). Roughly 200 primary pages were fetched; live numbers (GitHub stars, npm/PyPI/crates downloads, WordPress install counts, marketplace install counts) were pulled on 2026-08-31 unless stated otherwise. Items the research could not confirm from a primary source are marked "unverified".

**Method note:** This review was written to attack the thesis, not to improve it. Where the evidence is thin, it says so. Where the evidence is bad for the thesis, it does not soften it. A short list of research gaps appears at the end.

---

## Executive Verdict

**Useful product, questionable business.**

The runner-up verdict was "Interesting feature, weak standalone product", and the two are close. The deciding factor is that one narrow slice of the thesis (repo image policy + CI gate + batch before/after review) has no occupied incumbent and a plausible, if small, monetization precedent. Everything else in the thesis is either already free, already shipped by someone with distribution, or has been built two or three times by people who got one to fourteen GitHub stars for it.

Why not "Promising but thesis needs revision": the thesis's core bet is that a desktop workbench unifying GUI + CLI + AI + recipes + repo awareness + CI + MCP + plugins is a product category. The evidence says the category does not exist because the underlying problem is monthly-and-annoying for most developers, and for the one segment where it is weekly (WordPress), it is already monetized at upload time by 3.5M+ plugin installs and is moving into the browser in WordPress 7.1. Direct precedents that shipped nearly the exact feature list (Squish: single binary, `.imgoptrc`, before/after UI, 1 star; bthurlow/imagemagick-mcp: 57 tools including responsive sets and before/after, 2 stars; Squoosh CLI: dead for staffing reasons) are the strongest single piece of evidence in this review. Feature completeness is not the bottleneck. Demand is.

Why not "Do not build": the research turned up a genuine unoccupied space (per-glob image policy enforced in CI with auto-fix and a review surface), a real and documented gap in how coding agents handle image work (they guess quality settings, re-encode non-idempotently, cannot see AVIF, and judge compression artifacts at roughly chance on mid severities), a proven price band for "visual before/after review gated in PRs" (Chromatic $179-399/mo, Argos $100/mo, Applitools $667/mo), and a clear demand signal that developers resent per-transform metering (Vercel's 2025 pricing change and the bill-shock literature around it). That is enough to justify a cheap test. It is not enough to justify a desktop application, a plugin system, an MCP server, or a Pro tier.

The founder should read the rest of this document as: **the thesis identified a real seam, then wrapped it in six layers of product that the market has already declined to pay for.**

---

## Strongest Case FOR Rasterwright

Steelmanned honestly, the case rests on five findings that survived the research.

**1. There is no enforced image policy layer for repositories, anywhere.** Delivery-time optimization is solved (sharp: 93.85M weekly npm downloads; every framework and every CDN resizes and converts). Source-side hygiene (what gets committed) is not. The only tools found are `check-added-large-files` (size-only, 500 kB default), kitconcept's Image Checker GitHub Action (dimension and size checks, fails PR, 1 star), image-lint (stale, 183 weekly downloads), picopt (lossless-only `.picopt.yaml`), and calibreapp/image-actions (compresses in PRs, no policy, 1.6k stars, no release in about five years). Nothing combines size + dimension + format + aspect policy with auto-fix and a local CLI. This is the least crowded piece of the thesis by a wide margin.

**2. Coding agents have documented, current gaps that a deterministic toolchain fills.** From Anthropic's own vision docs and Codex's knowledge base: Claude vision cannot read AVIF, SVG, TIFF, or HEIC; Claude Code caps images at 5 MB with a known Read-loop bug on large screenshots (issue #27611); images are downscaled to at most 2576 px before the model sees them; localization is officially "approximate". Codex's March 2026 knowledge base states "autonomous path-based image reading is unreliable" and its sandbox blocks tool installs by default. DistortBench (April 2026) puts the best open VLM at 61.9% on a 4-choice distortion+severity task with compression artifacts "consistently challenging". Agents also guess quality settings from training priors and re-encode already-optimized files on re-run. A tool that returns deterministic metrics (bytes, dimensions, SSIM, face box vs. crop rect) and produces review-resolution before/after tiles is exactly what the literature says agents need. Anthropic's docs are explicit that CLAUDE.md is "context, not enforced configuration"; a policy file plus a CLI gate is the complement, not the competitor.

**3. Incumbents are structurally unable to occupy the local/git/CI position.** Cloudinary meters every plan on transformations, storage, and bandwidth; a local mode zeros its own meter. Every 2025-2026 Cloudinary move (five MCP servers, Cloudinary Agents, an Account Creation API so agents can create accounts) pulls toward the cloud. Adobe killed Photoshop API v1 on July 31, 2026 and put v2 behind an enterprise contract with a private rate card. Canva's MCP operates on cloud design objects and has no notion of a file, a repo, or a policy. No creative or cloud incumbent has ever shipped a CLI, a config file, a pre-commit hook, or a GitHub Action. The blind spot is a business-model wall, not a technical gap.

**4. "Visual review of automated image changes" has a working revenue precedent.** Engineering organizations pay Chromatic ($179/mo for 35k snapshots, $399/mo for 85k), Argos ($100/mo), Percy, and Applitools ($667/mo) for before/after diffs gated in PRs with approval history. That is the only place in the entire research where "review UI + policy + approvals" demonstrably converts to recurring revenue. An image-hygiene equivalent has never been tried.

**5. The demand signal for "pre-optimize in the repo" is real and recent.** Vercel moved from $5 per 1,000 source images to $0.05 per 1,000 transformations in February 2025 after loud complaints (HN thread: 112 points, 119 comments). The documented cost-cutting move in those threads is to pre-optimize with sharp at build time or commit optimized assets. Cloudflare's 5,000 free transforms and Bunny's $9.50 flat rate set the price anchor: developers will go to real effort to avoid per-transform metering on assets they already own.

Put together: a single-binary CLI that enforces a per-glob image policy in pre-commit and CI, auto-fixes with idempotent and reproducible encodes, produces a batch before/after report a human or VLM can review, and ships as a skill that Claude Code and Codex pick up natively, would be a genuinely new thing. It would also be small.

---

## Strongest Case AGAINST Rasterwright

This is the argument a hostile senior engineer, a coding-agent maximalist, and a seed investor would make together. It is uncomfortable because most of it is true.

**The transform layer is a wrapper over a library that ships 94 million times a week.** Every deterministic operation in the thesis (resize, crop with attention/entropy, format conversion, WebP/AVIF, metadata strip, responsive variants) is a sharp or libvips call. libvips 8.19 adds crop-by-point-of-interest. The one gap, byte-size targeting, is absent from sharp but present in `magick -define jpeg:extent`, `webp:target-size`, `cwebp -size`, `avifenc --target-size`, `jpegoptim -S`, and `caesiumclt --max-size`. It is a twenty-line quality loop that every coding agent writes on request. Reviewers will call Rasterwright "a skin over sharp" and they will be right.

**The problem is not frequent enough.** Web Almanac 2024: 99.9% of pages request images, LCP is an image on 73-83% of pages, only 12% of images are WebP and 1% AVIF. That is a delivery problem, and delivery is handled by frameworks and CDNs. For a front-end developer on Next/Astro/SvelteKit/Nuxt the manual touch is a new hero image or OG card roughly monthly. HN has had zero "Ask HN" threads about image workflows since 2023; the one big thread in three years was about Vercel billing, and the fix people chose was a sharp script or a cheaper CDN, not a new tool. Imgbot, the best-distributed automated fixer, reached about 53,000 installs in eight years and its code has not been pushed since January 2025. The market voted: nice-to-have.

**The one segment with weekly pain does not work in git.** WordPress and agency developers touch client images constantly, in the media library, at upload time. That moment is already monetized by Smush, EWWW, and Imagify (1M+ active installs each), ShortPixel (300k+), and Optimole (200k+) at $4-35/mo, and WordPress 7.1 (make/core, 2026-07-22) ships client-side wasm-vips processing in the browser by default in Chromium. A git-centric desktop workbench is orthogonal to how that segment actually works. This matters especially because the founder is in that segment and may be over-indexing on their own pain.

**Every "novel" combination has been built and ignored.** Squoosh had a GUI slider, per-codec JSON options, a CLI accepting the same JSON, and a Butteraugli auto-optimizer; Google abandoned the CLI and library for staffing and the app has had no commits since August 2024. keif's "Squish" is a single Go+libvips binary with API + web UI + CLI, a project-level `.imgoptrc`, batch, and interactive before/after comparisons: 1 star after 244 commits. bthurlow/imagemagick-mcp exposes 57 tools including batch, srcset responsive sets, strip-metadata, favicon sets, before/after, and image-diff: 2 stars. ImageSorcery, the most-starred local image MCP (329 stars), gets about two PyPI downloads a day. OpenCV MCP was archived in March 2026. The realistic adoption ceiling for a well-maintained niche front-end image CLI is optimizt: 184 stars after thirteen major versions.

**Coding agents already do the job and developers like it.** HN, 2025-2026: "I've used Claude to crop and resize images", "it loops around, checks the output and fixes things up", ImageMagick skill folders generating icon sets. Claude Code reads PNGs off disk as a routine path; Gemini CLI does too; Codex added `view_image` in March 2026. jezweb's Pillow skill (986-star repo) already answers "optimise these images" and "convert to webp" in Claude Code. danielrosehill's Claude-Image-Production-Plugin already has a "web-ready" orchestrator (HEIC/RAW in, strip EXIF, resize, AVIF + WebP + JPEG out) with profiles and preview-before-execute. The thesis's own Risk 1 is not a future risk. It is the present.

**"Become the standard image primitive agents call" has no mechanism.** There is no registry-level or model-level default that routes an agent to Rasterwright instead of `sharp`. The 2025-2026 consensus, including Anthropic's own engineering guidance, is CLI first, Skill to lock the workflow, MCP only for OAuth, multi-tenant, or no-CLI cases; published token costs are around 200 tokens per CLI call versus 32-82k tokens of MCP tool definitions per session. A local image tool has a CLI by definition, so it is exactly the case where an MCP server is a commodity wrapper. Vendors with real distribution (Cloudinary, Adobe, Figma, Canva, Transloadit, ImageKit) are already in both the MCP and Skills channels with hundreds to low thousands of installs a month.

**Nobody has ever built a recurring-revenue business on a local image utility.** Retrobatch (node-based batch processing, ML nodes, Shortcuts, JS plugins, Folder Actions) is a $19.99/$39.99 one-time solo-dev product. JPEGmini went freemium in May 2025. ImageOptim's desktop app is free; only its API earns money. Zipic already sells CLI + Shortcuts + Raycast + folder watch + presets for $29.99 one-time. Show HN launches of local image tools in 2024-2026 got 1-3 points each. The proposed "Pro = hosted AI" tier is the weakest tier in the thesis: Zed's founders wrote in September 2025 that "LLM bills have become our biggest expense, and more paying customers translates to more money lost"; Warp restricted BYOK to paid plans; Cline earns roughly $1 of ARR per install with zero inference markup and sells governance seats instead. BYOK users are the free tier forever. Sponsorship for sharp and libvips combined is about $18k a year; svgo's is about $430.

**The desktop GUI is the most expensive and least differentiated part.** Sixteen GUI batch tools were catalogued. Before/after sliders exist in Squoosh, IMGo, Caesium GUI, and ImageOptim. GitHub PR diffs already render 2-up, swipe, and onion-skin image comparisons natively (confirmed in the July 2025 Files Changed redesign). Building an Electron workbench means competing with free, on the platform where developers already review images, for a task they perform monthly.

**Maintenance is forever.** A libvips/sharp wrapper inherits sharp's release cadence and CVE stream (two high-severity libvips advisories in 2026 per npm). The precedents that died (Squoosh CLI, imagemin at 1.04M weekly downloads with no maintenance, smartcrop.js with no commits since March 2024, ImgBot) died from maintainer bandwidth, not competition.

The uncomfortable summary: **Rasterwright as described is a well-reasoned product for a problem that developers have already routed around, in a form factor they have repeatedly declined to pay for, positioned against a substitute (an agent plus sharp) that is already good enough for the frequency at which the problem occurs.**

---

## Competitive / Substitute Landscape

Threat level is rated for the thesis as written. "Validation" means the product proves demand or price tolerance rather than competing directly.

### Engine layer

| Product | What it does | Overlap | Where stronger | Where Rasterwright could differ | Threat |
|---|---|---|---|---|---|
| **sharp / libvips** ([sharp](https://sharp.pixelplumbing.com/), [libvips](https://www.libvips.org/)) | Node bindings to libvips. 0.35.4 (2026-08-26), 32.6k stars, 93.85M weekly downloads. `fit` modes, `strategy.attention/entropy` crop, `keepMetadata`, AVIF lossy now SSIMULACRA2-based (0.35.0). libvips 8.19 adds point-of-interest smartcrop. No native max-bytes option (verified). | The entire transform layer | Everything at the pixel level; adoption; every agent knows the API | Size targeting, batch UX, policy, review | Not a competitor; the substrate. Any claim of "deterministic transforms" as differentiation is void |
| **ImageMagick** ([imagemagick.org](https://imagemagick.org/)) | 7.1.2-30 (2026-08-23), 17.3k stars. `-define jpeg:extent`, `webp:target-size`, `-strip`, `-auto-orient`. No content-aware crop. | Transforms, size targets | Ubiquity, 200+ formats, agents know the syntax | Smart crop, policy, review | Not a competitor; the default substitute |
| **Optimizer CLIs** (oxipng 10.2, caesiumclt 1.4 with `--max-size`, rimage 0.13, jpegoptim `-S`, cwebp `-size`, avifenc `--target-size`, svgo 4.1 at 39M/wk, optimizt 13.0, picopt with `.picopt.yaml`, imgp 3.0, ImageOptim-CLI 4.0) | Single-purpose or aggregator optimizers | Transforms, size targets, per-dir config (picopt) | Single binaries, zero config, active | Cross-format policy, review | Low individually; collectively they make "batch optimize" free |
| **Squoosh** ([GitHub](https://github.com/GoogleChromeLabs/squoosh)) | Browser app, WASM codecs, before/after slider. 25.8k stars, no commits since 2024-08-19. CLI and lib "no longer maintained" (staffing). | GUI review, JSON config mirroring GUI, CLI, perceptual auto-optimizer | Brand, codec breadth | Batch, policy, repo | Low as competitor; **high as precedent**: Google could not fund the glue layer |

### Direct precedents (same shape as the thesis)

| Project | What it built | Adoption | Lesson |
|---|---|---|---|
| **keif/image-optimizer "Squish"** ([GitHub](https://github.com/keif/image-optimizer)) | Go + libvips single binary; API + web UI + `imgopt` CLI; project-level `.imgoptrc`; batch; interactive before/after | 1 star, 244 commits, pushed 2026-08-31 | Shipping the exact feature list does not create demand |
| **bthurlow/imagemagick-mcp** ([GitHub](https://github.com/bthurlow/imagemagick-mcp)) | 57 MCP tools: resize, smart-crop, convert, compress, strip-metadata, batch, responsive-set (400w-2400w), favicon/app-icon sets, image-diff, before-after | 2 stars, 0 forks | The "agent primitive" has been built; nobody installed it |
| **mlaprise/imagecli** ([GitHub](https://github.com/mlaprise/imagecli)) | Rust "image processing tool for agents", ships Claude skills | 5 stars, self-described vibe-coded | Agent-first positioning alone earns nothing |
| **Imgbot** ([marketplace](https://github.com/marketplace/imgbot)) | GitHub App: automated compression PRs, `.imgbotconfig`. $79-799/mo for private repos | 53,119 installs in ~8 years; repo last pushed 2025-01-28 | The ceiling for "Dependabot for images" |
| **calibreapp/image-actions** ([GitHub](https://github.com/calibreapp/image-actions)) | Action: compress changed images in PR, commit back, post before/after size table | 1,574 stars; no tagged release in ~5 years | `fix` in CI is done, adopted, and frozen |
| **kitconcept Image Checker** ([marketplace](https://github.com/marketplace/actions/image-checker)) | Action: min/max size, width, height; fails PR | 1 star | Policy enforcement exists and nobody adopted it |
| **danielrosehill/Claude-Image-Production-Plugin** ([GitHub](https://github.com/danielrosehill/Claude-Image-Production-Plugin)) | 15 skills: "web-ready" orchestrator (strip EXIF, resize, AVIF+WebP+JPEG), profiles, batch preview-before-execute, markdown logs | 16 stars | The agent-side version of Rasterwright's transform layer is a SKILL.md |
| **jezweb/claude-skills image-processing** ([SKILL.md](https://github.com/jezweb/claude-skills/blob/main/plugins/design-assets/skills/image-processing/SKILL.md)) | Pillow CLI: resize, convert, trim, thumbnails, OG cards, batch; triggers on "optimise images" | Repo 986 stars | "Ask Claude to optimize images" already has a canned answer |

### Cloud media platforms

| Vendor | What it does (2026) | Overlap | Where stronger | Where Rasterwright could differ | Threat |
|---|---|---|---|---|---|
| **Cloudinary** ([MCP docs](https://cloudinary.com/documentation/cloudinary_llm_mcp), [pricing](https://cloudinary.com/pricing)) | Five official MCP servers (June 2025 on), Cloudinary Agents (May 2026), skills pack that compiles NL to transformation URLs, Console Studio visual builder, Image Generation API (July 2026), VS Code extension GA. `cld` CLI is API-only; zero local pixel processing. Free 25 credits; Plus $99; Advanced $249. $100M ARR (2021), $2B valuation (2022), 11,000 customers (May 2026 PR); current ARR unverified. | NL to transform, responsive, WebP/AVIF, `q_auto`/`g_auto`, MCP, batch | Delivery, video, DAM, AI, enterprise, brand | Files stay in git, no upload, deterministic, unmetered, CI `check` | **Medium.** Can copy every surface feature in a quarter; will not copy the business model. Risk is irrelevance, not takedown |
| **Cloudflare Images** ([pricing](https://developers.cloudflare.com/images/pricing/)) | 5,000 free unique transforms/mo, then $0.50/1k; `gravity=auto|face`, `format=auto`, free BiRefNet background removal (beta Aug 2025) | Every basic transform | Price, edge, free AI bg removal | Repo files, review, policy | **Medium** as price anchor; low on product overlap |
| **ImageKit** ([MCP](https://imagekit.io/docs/mcp-server)) | MCP launched 2025-11-11 with `transformation_builder` (NL to URL); cheapest AI ops; bootstrapped ~$3.5M revenue (unverified) | NL to transform, MCP, cheap AI | Speed of shipping, price | Upload-bound | **Medium**: fastest small mover |
| **Transloadit** ([MCP post](https://transloadit.com/blog/2026/02/transloadit-mcp-server/)) | MCP (Feb 2026) with local and hosted modes; lintable Assembly templates; "version-controlled Agent Skills" that teach agents repeatable media workflows. 2,828 npm downloads/month (highest of any image-capable vendor MCP found) | Recipe + lint + agent; the closest philosophical neighbor | Hosted execution, 80+ robots | Local execution, repo files | **Medium**: they have already articulated the deterministic-recipe-for-agents idea |
| **Vercel Image Optimization** ([changelog](https://vercel.com/changelog/faster-transformations-and-reduced-pricing-for-image-optimization)) | $0.05/1k transformations since 2025-02-18 (was $5/1k source images); bill-shock posts ($20 to $700 months) | Responsive, WebP/AVIF | Zero-config in Next | Pre-optimize so the platform never bills | Low as competitor; **high as validation** |
| imgix, Uploadcare, Bunny ($9.50/site flat), Sirv, Fastly, Akamai, Netlify, Filestack | Delivery/transform CDNs | Transforms | Delivery | Everything local | Low |
| **Photoroom API** ([pricing](https://www.photoroom.com/api/pricing)) | $0.02/img basic (remove bg, crop/resize), $0.10 plus; `outputSize`, `scaling`, `padding`, `export.format=webp|avif`, `preserveMetadata`; batch endpoint; remote MCP (~May 2026); $94.5M ARR 2024 | "Make this 1600x900 and keep the subject" is one API call | E-commerce GTM, AI cutout quality | Local, deterministic, KB budgets, responsive sets, no per-image tax | **Medium**: strongest overlap on the NL promise |
| **TinyPNG / Tinify** ([API pricing](https://tinify.com/pricing/api)) | 500 free compressions/mo, $0.009 then $0.002 each; WordPress and Figma plugins | Compression, conversion | Brand, plugins | Local | Low |
| **WordPress optimizer plugins** (Smush, EWWW, Imagify 1M+ each; ShortPixel 300k+; Optimole 200k+; Modern Image Formats 100k+) | Upload-time optimization; $4-35/mo | The WordPress segment's actual workflow | Zero-effort, inside the CMS | Nothing for this segment; git is not where their images live | **High for the WordPress segment**: it is already served |

### Creative and design incumbents

| Vendor | What it does (2026) | Overlap | Where Rasterwright could differ | Threat |
|---|---|---|---|---|
| **Adobe** ([Photoshop API](https://developer.adobe.com/firefly-services/docs/photoshop/), [Adobe MCP listing](https://mcpservers.org/remote-mcp-servers/adobe-creativity)) | Photoshop AI Assistant public beta (March 2026, web/mobile only, no batch); "Adobe for creativity" remote MCP GA in Claude April 2026 with 50+ tools (secondhand); Photoshop API v1 EOL 2026-07-31, v2 enterprise-only with private rate card; batch WebP still needs a recorded "Save a Copy" action; Express bulk resize is Premium | Resize/crop/convert/remove-bg via chat and MCP | Local files, deterministic, KB targets, responsive sets, repo policy, CI, no credits, no account | **Medium**: high capability, low intent; actively getting worse for small devs |
| **Canva** ([MCP docs](https://www.canva.dev/docs/mcp/)) | Design MCP (resize design, export PNG/JPG/PDF; no asset upload, no pixel edit, no WebP/AVIF, no local files); Canva Code is for widgets inside designs; Affinity now free (Oct 2025) with flaky macros and no scripting API; 265M MAU, $4B ARR | Bulk Create from CSV is the closest thing to recipes | Git, CI, files, policy | **Medium-Low** |
| **Photopea** ([API](https://www.photopea.com/api/)) | Free scripting API (Photoshop-compatible JS, `saveToOE("webp:0.8")`), solo founder, ~$3M/yr mostly ads | Scripted resize/convert for free | Determinism, headless, CLI, policy | Low |
| **Figma + TinyImage** ([TinyImage](https://www.hypermatic.com/tinyimage/)) | Figma MCP exports PNG/JPG/SVG/PDF only; TinyImage plugin does AVIF/WebP export with **kilobyte size targets**, $20/seat/mo | Size targeting with a price tag | Post-export file hygiene | Low as competitor; **validation** that KB targets command $20/seat |
| GIMP 3.x MCPs (five community servers, best 192 stars), Pixelmator Pro (Apple, Shortcuts), Krita, Acorn, Pinta | Editors with hobby-grade automation | Batch in every editor | Developer/CI positioning | Low |
| Google Photos "Ask Photos", Apple Photos Clean Up/Extend | Consumer NL editing | Set user expectations for NL editing | Never touch dev workflows | Low |

### AI assistants and coding agents

| Product | Relevant capability (2026) | Where it beats Rasterwright | Documented gaps Rasterwright could fill | Threat |
|---|---|---|---|---|
| **Claude Code** ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision), [skills](https://code.claude.com/docs/en/skills)) | Reads PNG/JPG/GIF/WebP off disk routinely; Skills (agentskills.io standard); `/run` + `/verify` record per-repo recipes; Chrome screenshots; `.claude/rules/` with path-scoped frontmatter | One-off crop/resize/convert with human check; developers report liking it | No AVIF/SVG/TIFF/HEIC vision; 5 MB cap and Read-loop bug (#27611); images downscaled to 2576 px; "coordinates approximate"; guessed quality settings; non-idempotent re-encodes; prose instead of before/after; CLAUDE.md "not enforced configuration" | **High** for one-off work (already won); the gaps are the product |
| **Codex** ([knowledge base](https://codex.danielvaughan.com/2026/03/28/codex-cli-image-workflows/)) | `--image` input; `view_image` tool (0.117, March 2026); Skills; `$imagegen` (generation only, explicitly declines deterministic work) | Same as above | "Autonomous path-based image reading is unreliable"; sandbox blocks installs by default | High, gap closing within a year |
| **Gemini** ([image docs](https://ai.google.dev/gemini-api/docs/image-generation)) | Nano Banana 2/Pro editing; Gemini CLI `read_file` supports images | Semantic edits | No seed, JPEG/PNG only, HN reports of random edits at temperature 0 | Not a deterministic competitor |
| **ChatGPT** ([image API](https://developers.openai.com/api/docs/guides/image-generation)) | gpt-image-2 (April 2026); Python tool does deterministic Pillow ops | Interactive one-offs | Masks are "guidance"; 10 files per message; download links, no repo | Not a deterministic competitor |
| Cursor, Copilot coding agent, Cline, Windsurf, Kiro | Browser-screenshot verification; Playwright MCP by default in Copilot | UI verification | No documented "open arbitrary local PNG" path (Cursor, Cline); unverified for Windsurf/Kiro/Amp | Medium |

### MCP servers and agent skills

Full table in the research notes. Summary: the official MCP registry lists about 35 image-manipulation servers; the most-starred local one (ImageSorcery, 329 stars) gets ~663 PyPI downloads a month; combined, every local image MCP is under ~2k downloads a month against sharp's 361.5M. No official image manipulation MCP or skill exists from Anthropic, OpenAI, Google, Microsoft, or Cloudflare. Anthropic's skills repo (173k stars, 17 skills) has no image optimization skill; GitHub's awesome-copilot ships a thin `image-manipulation-image-magick` SKILL.md. Blender MCP (22k+ stars) is the precedent for "agent drives a creative app" and succeeds because Blender has no CLI-friendly surface and the output is generative; deterministic resize/convert is the opposite profile. Threat from MCP ecosystem: **none as competitor, high as evidence of no demand.**

### Build-time and IDE

| Layer | State | Implication |
|---|---|---|
| Frameworks | Next.js (request-time), Astro/SvelteKit/11ty/Hugo/Gatsby (build-time via sharp), Nuxt/unpic (40+ CDN providers), vite-imagetools 280k/wk, vite-plugin-image-optimizer 276k/wk | Delivery is solved; source hygiene matters only for `public/` folders, repo bloat, CI cache, pipeline-less sites |
| GitHub | PR image diff: 2-up, swipe, onion-skin, dimension delta, confirmed in the 2025-07-31 Files Changed redesign; 100 MiB block, LFS metered | Per-image review in the PR is free and already there |
| VS Code | Image preview 4.23M installs (passive); Luna Paint 339k (real editor, "preview" label, monthly releases); all optimizer extensions combined under 200k; swipe diff request closed "not planned" | Demand for in-editor image manipulation is real but small |
| JetBrains | PNG Optimizer 19k, TinyPNG 16k, WebP converter 3k downloads | Negligible |

---

## Workflow-by-Workflow Reality Check

For each job in `01-product-thesis.md`, the best workflow available on 2026-08-31 versus the proposed Rasterwright experience, with an honest friction comparison.

### "Optimize every image in this repository." (Job 2, Job 5)

**Best today:** Add `calibreapp/image-actions` to a workflow (about ten lines of YAML); it compresses changed images in every PR with libvips, commits back, and posts a before/after size table. For a one-time sweep: `npx sharp-cli`, `caesiumclt -RS --max-size`, or `optimizt`. Or one prompt to Claude Code, which globs, installs sharp, writes a script, runs it, and reports the savings from `du`.

**Friction today:** Low. The agent path takes one prompt and a permission click. The action path takes one YAML file.

**Rasterwright's proposed edge:** policy, idempotence, exceptions surfaced, review before apply. **Reality:** the agent path guesses quality (jezweb's skill hardcodes q85 and 1920 px), re-encodes already-optimized files on re-run, and shows prose instead of pixels. Those are real but small deficits on a job most teams do once and then forget. **Verdict:** marginal advantage, and only if the policy and idempotence markers are genuinely better than a `.optimiztrc.cjs`.

### "Make this image 1600x900, preserve the subject, WebP, under 250 KB." (Job 1)

**Best today:** `sharp(input).resize(1600, 900, { fit: 'cover', position: sharp.strategy.attention }).webp({ quality })` in a loop until under 250 KB; or `magick in.jpg -resize 1600x900^ -gravity center -extent 1600x900 -define webp:target-size=256000 out.webp` (no smart crop in ImageMagick); or one Photoroom API call (`outputSize=1600x900&scaling=fit&padding=10%&export.format=webp`, $0.02-0.10, cloud, non-deterministic cutout); or one prompt to Claude Code, which will then Read the output to check the crop.

**Friction today:** Low for a developer who has done it before; one prompt otherwise.

**Rasterwright's proposed edge:** immediate preview of the crop. **Reality:** Claude Code can already Read the WebP it produced. The advantage is a human seeing the crop at full resolution versus the model seeing it downscaled with "approximate" localization. That is a real UX gain for the 5% of crops where the subject is off-center by a small margin. **Verdict:** small but genuine advantage on subjective crops; none on the rest.

### "Generate responsive variants." (Job 2)

**Best today:** The framework does it. Astro `<Image layout>`, next/image, `@sveltejs/enhanced-img`, `vite-imagetools` (`?w=400;800&format=avif;webp&as=srcset`), eleventy-img, Hugo. For pipeline-less sites: Jampack post-build, or bthurlow's MCP `responsive-set` tool, or a ten-line sharp script.

**Friction today:** Zero for framework users.

**Rasterwright's proposed edge:** none for framework users; convenience for pipeline-less sites. **Verdict:** no advantage where most developers live.

### "Find image-policy violations in a repository." (Job 5)

**Best today:** `check-added-large-files` (500 kB, size only), kitconcept Image Checker (dimension and size, fails PR, 1 star), or a custom script. Nothing checks format, aspect, or per-glob rules with auto-fix.

**Friction today:** High if you want anything beyond "file too big". Effectively nobody does it.

**Rasterwright's proposed edge:** the whole feature. **Reality:** this is the one job with no good answer today. The counter-evidence is that the one tool that tried (Image Checker) got one star, and the 500 kB size guard covers most of the felt pain in one line. **Verdict:** real gap, unproven demand. This is the wedge if there is one.

### "Batch convert these assets."

**Best today:** `magick mogrify -format webp *.png`, `caesiumclt`, XnConvert, Zipic ($29.99, ships a CLI and folder watch), PowerToys Image Resizer, macOS Shortcuts, or one prompt to an agent.

**Friction today:** Trivial.

**Rasterwright's proposed edge:** none. **Verdict:** no advantage.

### "Visually inspect the results of an automated transformation." (Job 3)

**Best today:** Open the PR; GitHub renders 2-up/swipe/onion-skin per image. Locally: Squoosh's slider (one image at a time), IMGo or Caesium GUI comparison views, ImageOptim's savings list (no pixels). For agent-produced batches: ask the agent to Read each output (costly, downscaled, unreliable on subtle artifacts per DistortBench).

**Friction today:** Per-image review is free in the PR. Batch review with a policy summary, exceptions first, and zoomable before/after tiles does not exist locally.

**Rasterwright's proposed edge:** batch review UI tied to the policy and the CLI. **Reality:** genuinely unbuilt. The research found no evidence anyone has asked for it, and most optimizers are near-lossless so people skip review entirely. **Verdict:** real gap, unknown demand. The Chromatic precedent suggests it converts only when it lives in the PR workflow with history and approvals, not as a desktop window.

### "Have an AI coding agent manipulate project images." (Job 6)

**Best today:** Let the agent run `sharp` or `magick` directly, optionally guided by a SKILL.md (jezweb, danielrosehill, awesome-copilot). Every skill author surveyed chose script + SKILL.md over an MCP server, several citing reproducibility.

**Friction today:** One prompt. The documented failure modes are guessed settings, non-idempotence, blind spots (AVIF, >5 MB), and unreliable quality judgment.

**Rasterwright's proposed edge:** a stable primitive via MCP. **Reality:** fifteen people built that primitive; nobody installed it. What the agent actually lacks is structured results (bytes, dimensions, SSIM, face box vs. crop rect), review-resolution before/after tiles it can consume in one image, and conversion of formats it cannot see. Those ship better as a CLI + skill than as an MCP server. **Verdict:** the MCP framing is wrong; the underlying need (deterministic metrics and review tiles for agents) is real and grows as agents become the primary caller.

### "Turn a one-off transformation into a reusable recipe." (Job 4)

**Best today:** Claude Code's `/run-skill-generator` records per-repo procedures; a SKILL.md with a script; `.optimiztrc.cjs`; `.picopt.yaml`; Squoosh's JSON (dead); Transloadit templates (cloud); Photoshop Actions.

**Friction today:** Medium, and fragmented across formats.

**Rasterwright's proposed edge:** one format spanning GUI, CLI, CI, agent. **Reality:** the format only matters if it is enforced somewhere; otherwise an agent ignores it as readily as it forgets CLAUDE.md after compaction. **Verdict:** valuable only as the input to `check`/`fix`, not as a standalone artifact.

---

## AI Commoditization Analysis

The thesis's Risk 1 asks whether coding agents make the product unnecessary. The research answer is that for one-off work they already have, and the remaining opportunity is in what agents structurally do not provide.

### Can "optimize every image in this repo, inspect visually, fix bad crops" work today?

What Claude Code on Opus 5 actually does, step by step, based on the documented capabilities:

1. Globs images, checks for sharp or magick, installs via npm or asks to apt-get (permission prompt; fails in a network-off sandbox until allowed).
2. Writes a script with guessed max width and quality (typically 80-85) unless CLAUDE.md says otherwise.
3. Runs it, reports "saved 62%" from `du`.
4. If told to verify: Reads outputs one by one at 1.3-4.8k tokens each, all of which stay in context. After 40-100 images the context is mostly pixels and compaction blurs earlier verdicts. Scaling requires the developer to know to ask for subagents per directory.
5. Any AVIF output or any file over 5 MB cannot be Read. It may convert to PNG first if it notices; issue #27611 shows it can instead loop.
6. "Fix bad crops": proposes a new crop box from approximate localization, re-crops, re-Reads. Works for gross errors (head cut off). For a 1200x630 OG card with the subject 8% off-center it typically declares success.
7. You get prose and a git diff of binary files. No before/after is shown.

Cost for 300 images with before-and-after review: roughly 1.5-3M input tokens, $8-15 on Opus 5 or $1.50-3 on Haiku 4.5, 1-2.5 hours serialized. Cost is not the argument. Determinism, idempotence, format blind spots, and review UX are.

**One-year projection (mid 2027):** steps 1-3 become routine and are recorded as a per-repo skill after the first run; step 4 gets cheaper and the size-stall bug is fixed; every mainstream agent reads local images by path; screenshot-in-PR is table stakes. Agents will still guess settings absent a policy, still not show a before/after grid, and still be unreliable on subtle artifacts. "Reliably" for gross crop failures: likely. For the full job unattended: no.

**Three-year projection (2029):** the transform half is fully commoditized inside agents (prompt, script, run, verify via VLM pairwise comparison, subagents for scale). DistortBench's finding that compression-severity judgment does not improve monotonically with scale suggests absolute quality scoring stays unreliable longer than people expect. What remains non-native is the contract: a versioned, enforceable, cross-agent policy; deterministic idempotent recipes; human-in-the-loop visual review; CI enforcement; provenance for autonomously committed binaries.

### Features likely to become commodity (or already are)

- Ad hoc resize/crop/convert on a handful of files. Every agent with bash and sharp does this now.
- Natural language to ImageMagick/sharp command, and natural language to YAML. Cloudinary's skill already compiles NL to transformation strings; ImageKit has `transformation_builder`. The value of NL-to-YAML is only the YAML.
- Background removal (BiRefNet, BEN v2 are MIT; rembg is 24.6k stars), basic upscaling, OCR. Wrappers around free models; skills already exist.
- EXIF reading, metadata stripping, srcset generation. Trivial scripts.
- A desktop GUI wrapper around any of the above. Sixteen exist.
- An MCP server exposing any of the above. Fifteen exist.
- "Repo awareness" in the sense of knowing where images are and how they are referenced. Agents have this natively; frameworks know their own assets.

### Features that may remain product opportunities

- **Deterministic, idempotent recipes with pinned encoder versions and provenance markers.** Agents produce a fresh script each run; encoder versions, filters, and flags drift. Reproducibility across machines and CI is a toolchain property, not a model property. Idempotence (do not re-encode an already-compliant file) is something agents rarely do unprompted.
- **Byte-size and perceptual-quality targeting as first-class operations.** Binary search on quality to hit a KB budget with an SSIMULACRA2 or DSSIM floor. Sharp 0.35 just started using SSIMULACRA2 internally for AVIF; almost no CLI exposes a perceptual target. TinyImage proves people pay $20/seat/mo for KB targets inside Figma.
- **A policy file plus a CI gate.** Anthropic's docs: CLAUDE.md is "context, not enforced configuration"; "to block an action regardless of what Claude decides, use a PreToolUse hook." The AGENTS.md field guide: "if a violation would block a merge in CI, enforce it there." Prose states intent; a CLI enforces it; no agent's memory survives a vendor switch.
- **Batch before/after review with exceptions first.** Nobody does this locally or in the PR. VLIC (Dec 2025) shows pairwise A/B is the modality where even models are reliable; humans need it more.
- **Handling what vision models cannot see.** AVIF, HEIC, TIFF, SVG rasterization, and images over the model's size cap. The tool converts for review; the agent cannot.

### Features that become MORE valuable as agents improve

- **Structured results an agent can reason about.** Dimensions, bytes, SSIM/SSIMULACRA2, saliency and face boxes versus the crop rectangle, "compliant: true/false" per policy rule. As agents become the primary caller, a tool that returns facts beats one that returns "done". DistortBench implies agents will need deterministic metrics to make quality calls for years.
- **Policy as a machine-readable contract every agent honors identically.** Multi-agent shops (Claude Code + Codex + Cursor + Copilot in the same repo) are normal in 2026; prose conventions drift per vendor; one YAML and one CLI do not.
- **Review-resolution proxies for VLM consumption.** A 1568 px, labeled, pairwise before/after contact sheet with the crop rectangle drawn on is exactly the input form VLIC shows works. Producing those tiles cheaply is a toolchain job that gets more useful as more agents can look. This is the single genuinely open gap the MCP research found.
- **Provenance and audit of which transform produced which bytes.** As agents start committing binaries autonomously, brand-controlled and regulated repos will want to know what happened to `hero.jpg` and be able to reproduce it.
- **Local semantic primitives exposed deterministically.** BiRefNet cutout, saliency map, face detection as computed inputs to a re-crop, so "fix bad crops" becomes a computed operation, not a model's approximate bounding-box guess.

The pattern: everything that is a *capability* commoditizes; everything that is a *contract* (policy, determinism, reproducibility, review, provenance) does not, and gets more valuable the more autonomous the caller.

**Biggest commoditization risk not in the thesis:** Anthropic's bundled `/run` + `/verify` + `/run-skill-generator` skills already record per-repo procedures with visual verification. An official "media processing" skill with a before/after screenshot step would be cheap for Anthropic or OpenAI to ship. No evidence anyone is building it; it would remove most of the agent-facing wedge overnight.

---

## Moat Assessment

| Claimed moat (thesis section 13) | Rating | Why | What would have to happen for it to become defensible |
|---|---|---|---|
| Recipe format | **Weak** | Squoosh JSON, `.optimiztrc.cjs`, `.picopt.yaml`, Transloadit templates, Photoshop Actions, SKILL.md scripts all exist. Agents write the JS equivalent in one shot. A format is only sticky if something enforces it. | The format is adopted as the enforcement input by a framework (Astro, Next), a platform (GitHub), or an agent vendor's official skill. Otherwise it is internal complexity. |
| Project policies (`.imgdev.yml`) | **Weak, potentially moderate** | Least crowded piece. But Image Checker (policy in CI) has 1 star; `check-added-large-files` covers 80% of felt pain in one line. Demand is unproven. | Evidence that teams with many image committers (docs, design systems, OSS, marketing sites) adopt and keep the gate; a framework or GitHub feature does not absorb it first. |
| Repo awareness | **Weak** | Agents have it natively; frameworks know their assets; git already knows what changed. Nothing proprietary about globbing. | Only defensible as accumulated hosted history (see below), not as a local capability. |
| Visual review | **Weak as a moat, strongest as a feature** | The UI is copyable in a weekend (Squoosh slider, IMGo, GitHub's onion-skin). Chromatic's moat is not its diff viewer; it is the snapshot history and approval workflow tied to CI. | Move the review into the PR with hosted history, approvals, and per-image accountability. Then the data is the moat, not the viewer. |
| CLI | **Nonexistent** | Table stakes. `npx sharp-cli`, `caesiumclt`, `magick` exist. | Never a moat; only distribution. |
| CI | **Weak** | calibreapp/image-actions did `fix` in CI five years ago and froze. CI is the *place* the product should live, not a moat. | The Chromatic pattern: CI gating plus hosted history plus approvals is the only version that monetized. |
| MCP | **Nonexistent** | Fifteen image MCPs, best at 329 stars and 2 downloads/day; ecosystem consensus (Anthropic included) is CLI + Skill for local tools; 32-82k tokens of tool definitions vs ~200 per CLI call. | No mechanism exists to become "the primitive agents call". Ship a skill, not a server; treat MCP as a client-without-shell channel. |
| Plugins / extensibility | **Nonexistent** | Requires an ecosystem to exist first. sharp *is* the plugin ecosystem; libvips loads codecs. Premature by years. | Thousands of users first. |
| Local-first architecture | **Nonexistent vs. open source; moderate vs. cloud vendors** | Every OSS tool and every Show HN launch is local. Zipic sells local + CLI + folder watch for $29.99. Against Cloudinary/Photoroom it is a real business-model wall, but that only matters if Rasterwright is competing for their customers, which it is not. | Local-first is a *prerequisite* for developer trust, not a differentiator. Say it; do not sell it. |
| Community | **Weak** | Does not exist yet. Realistic ceiling for a niche front-end image CLI is optimizt (184 stars after 13 majors) or Jampack (1.7k). | Sustained maintainer bandwidth, which is exactly what killed Squoosh CLI, imagemin, smartcrop.js, and ImgBot. |
| Open source | **Nonexistent as moat** | Open source is distribution and trust, not defensibility. Sponsorship for sharp/libvips is ~$18k/yr total. | Only helps with a hosted or embedded product behind it (imgproxy Pro, Transloadit, Pintura, Bruno, n8n). |
| Accumulated project context | **Weak, potentially moderate** | Locally, git history and CLAUDE.md already hold it. Hosted review history with approvals (who accepted which crop, which policy exceptions were granted) is the only version that accumulates switching cost. | Build the hosted history layer; that is the Chromatic moat transplanted. |
| Becoming the standard image primitive agents call | **Nonexistent** | No routing mechanism; agents default to sharp/magick; vendors with distribution (Cloudinary, Adobe, Figma, Transloadit, ImageKit) are already in the MCP and Skills channels; ~35 servers compete for near-zero usage. | An agent vendor bundles it as the official skill, or a framework calls it by default. Neither is in Rasterwright's control. |

Net: no moat rated above "weak" today. The only path to "moderate" runs through hosted review history and approvals in CI, which is a different product from the desktop workbench in the thesis.

---

## Market / Willingness-to-Pay Assessment

Segments ranked by likelihood of paying, with "would use" separated from "would pay".

| Rank | Segment | Would use | Would pay | Evidence | What they would pay for |
|---|---|---|---|---|---|
| 1 | Engineering teams with image-heavy repos (docs sites, design systems, marketing sites on plain hosts, OSS with many screenshot committers) | High | **Medium-high, only for a CI-gated hosted review layer** | Chromatic $179-399/mo, Argos $100/mo, Applitools $667/mo; HN "images are compressed before getting committed to git" (Jan 2026) | Per-image-reviewed or per-snapshot pricing, $100-400/mo per org, history and approvals |
| 2 | WordPress / agency shops | Medium (they live in the media library) | **Low-medium, only at ShortPixel price points** | Smush/EWWW/Imagify 1M+ installs each at $4-35/mo; ShortPixel unlimited $9.99/mo; ManageWP $1-2 per site per add-on; WP 7.1 client-side processing | Something that runs automatically inside the CMS, per site. A desktop tool is not in this purchase path |
| 3 | Individual developers, indie hackers, technical founders | High if free, local, CLI, skill | **Low: $15-40 once, never recurring** | Zipic $29.99, Retrobatch $19.99-39.99, Optimage $15, Squash $24.99, JPEGmini went freemium; no precedent for recurring image-utility revenue from individuals; BYOK users will not buy hosted AI | One-time license for power features (watch folders, presets) |
| 4 | Freelance developers | High if free | Very low | Same as individuals, with fewer repos | Nothing recurring |
| 5 | E-commerce teams | Low for this shape | High, but to Photoroom ($94.5M ARR), Cloudinary, Pixelz ($0.95/image), not to a repo tool | They need generative cutouts and delivery at volume, priced per image | Not this product |
| 6 | CMS-heavy content teams | Low (non-developers) | Low | Their images live in the CMS or DAM, not in git | Not this product |
| 7 | Enterprise engineering organizations | Very low as a desktop tool; medium as a CI policy gate in monorepos | Medium, via the same CI layer as rank 1, with SSO/audit | DAM budgets (Bynder median $39k/yr) are owned by marketing ops and buy storage/governance, not transforms | Policy enforcement + audit across many repos, sold as seats or org tier |

Frequency by segment (from the CI/build research): monthly and annoying for framework front-end developers; weekly but already served for WordPress; painful enough to standardize only for teams with many contributors committing screenshots and hero images outside any framework pipeline.

Can this support a small profitable company? Possibly, if the product is the rank-1 CI review layer and the company is two to four people. The comparable is Argos ($100/mo tier, small team) or Polypane (solo founder, $9-54/mo, alive since 2019), not Chromatic.

Can this support a venture-scale company? No evidence supports it. The addressable spend on source-side image hygiene is a rounding error against delivery/CDN and DAM. Cloudinary's $100M+ ARR is delivery. Photoroom's $94.5M ARR is generative e-commerce cutouts. The category Rasterwright would own has no company in it above optimizt scale, and the closest paid analog (Imgbot at $79-799/mo) has 53k installs and a dormant repo.

Does the distinction matter for design? Yes, decisively. A small-company version should be a single-binary CLI + GitHub Action + skill with a modest hosted review tier, built by one or two people, with no desktop app. A venture version would need to own delivery or DAM, which means competing with Cloudinary and Cloudflare on their turf. The thesis is currently designed like the venture version (eight surfaces, plugin system, Pro/Teams/API tiers) with the market of the small version.

---

## Open-Source Business Model Assessment

**Does open source help or hurt here?** It helps, and it is close to mandatory, but it is not a business model.

Why it helps: every successful local developer tool in the research is open source or source-available at the core (Bruno, Cline, n8n, imgproxy, Pintura's editor, Upscayl). Forcing cloud or login on a local workflow is the fastest documented way to lose the audience (Insomnia's 2023 forced login produced Bruno, now 44k stars and selling Pro at $6/user/mo). Developer trust in a tool that touches project assets requires reading the code. Agent skill distribution (agentskills.io, Claude Code and Codex marketplaces, awesome-copilot) effectively requires an open repo.

Why it does not fund anything: sharp and libvips, the most-used image libraries in existence, raise about $18k a year on OpenCollective. svgo, at 39M weekly downloads, raises about $430. Squoosh, backed by Google, could not staff its CLI. Local-desktop OSS with no server component (Upscayl, Caesium, Image Toolbox) stays at donation level unless it adds hosted GPU credits (Upscayl Cloud at $24.99/mo).

What worked for open-core dev tools: a hosted control plane or embedded product behind the open core. Supabase, PostHog, n8n ($100M ARR, execution-based pricing) are infrastructure. For desktop/GUI tools: Bruno ($6-11/user/mo for git and automation features layered on the local workflow), Hoppscotch ($6/user/mo), Excalidraw+ ($6/user/mo for cloud scenes), Penpot ($7/user/mo). For image tools specifically: imgproxy Pro ($49/mo, sells advanced compression to self-hosters), Transloadit (hosted pipeline funds Uppy), Pintura (EUR 749/yr per developer seat for an embeddable editor).

**Does BYO API key undermine SaaS revenue?** Yes, for a "Pro = hosted AI" tier specifically. Zed (Sept 2025): "LLM bills have become our biggest expense, and more paying customers translates to more money lost"; they moved to list price plus 10% and cut Pro to $10. Warp only allows BYOK on paid plans and restructured its pricing. Cursor gates Agent behind Pro regardless of BYOK. Cline: BYOK, zero markup, ~$1 ARR per install, sells governance seats. Bessemer's 2025 data puts AI-app gross margins around 25%, many negative. Image transforms are also cheap to run locally, so the hosted-AI upsell is thinner here than in coding tools. BYOK users are not a conversion funnel; they are the free tier forever.

**Is hosted AI a good monetization layer?** No. It is a cost center with margin risk and a feature that every competitor gives away (Cloudflare bundles BiRefNet background removal free; ImageKit prices AI at a tenth of remove.bg). Treat NL-to-recipe and semantic operations as free-tier features with BYOK or a small capped allowance; if a hosted convenience is offered, mark it up (Zed's +10%) or cap it.

**Are CI, teams, automation, or APIs more promising than the desktop application?** Yes, unambiguously. The only place in this research where "review + policy + approvals" converts to recurring revenue is CI visual review (Chromatic, Argos, Percy, Applitools), priced on volume (snapshots) to engineering organizations. The desktop application has no monetization precedent above $40 one-time.

**Strongest monetization model if the product survives:**

1. Free, open-source (MIT or Apache) single-binary CLI + GitHub Action + pre-commit hook + agent skill. Never gate local transforms, policy checks, or the local review report. This is distribution.
2. Hosted "review layer" for teams: per-image-reviewed pricing on PR checks, review history, approvals, policy exceptions with audit, cross-repo policy inheritance. Free up to a few thousand images a month; $100-400/mo per organization above that. This is the Chromatic pattern and the only tier BYOK cannot erode.
3. Optional one-time desktop or power-feature license ($29-49, the Zipic/Retrobatch range) if a GUI ever ships. A small revenue line, not the core.
4. No "Pro = hosted AI" tier. No plugin marketplace. No API tier until someone asks to pay for one.

---

## Scope Critique

The thesis contains at least eight product surfaces. Most are premature, several are distractions, and two actively work against the product's chances.

### Should NOT be in v0.1

- **The desktop GUI application (Electron or otherwise).** Most expensive surface, least differentiated (sixteen GUI batch tools, before/after sliders in four of them, GitHub's own onion-skin diff), zero monetization precedent above $40 one-time, and it forces the "open an image, edit it" mental model the thesis says it does not want. A static HTML report or a local web page opened by the CLI delivers the visual review without the app.
- **Natural-language intent as a core feature.** It is a demo feature. Every incumbent has it; Cloudinary and ImageKit already compile NL to transforms; the agent the developer is already talking to can write the YAML. NL belongs in a SKILL.md that teaches Claude Code and Codex to author `.imgdev.yml`, not in the product.
- **The MCP server as a flagship interface.** Fifteen exist, none adopted; the ecosystem's own guidance says CLI + Skill for local tools. Ship a skill. Add MCP later only for clients without a shell (claude.ai, Claude Desktop, ChatGPT connectors), and only to return review tiles inline.
- **Plugins and extensibility.** No ecosystem to extend. Years premature.
- **Generative operations (outpainting, object removal, background generation).** Different problem, different competitors (Photoroom, Adobe, Nano Banana), nondeterministic, credit-metered. The thesis says "deterministic first"; v0.1 should be deterministic only.
- **Provider-interchangeable AI backends.** Solves a problem the product does not yet have.
- **Pro tier (hosted AI, model routing, cloud recipe sync, project history, remote jobs).** Every element is either margin-negative (hosted AI), unwanted (sync of a YAML file that lives in git), or a different product (remote jobs).
- **Teams tier as designed (roles, permissions, approvals, centralized AI usage).** Only the approvals piece has precedent, and only inside a CI review workflow.
- **API/automation tier, remote batch jobs, hosted CI infrastructure.** No demand signal; GitHub Actions is the CI infrastructure.
- **"Repo awareness" beyond globbing and git status.** Agents and frameworks already have the deeper version.
- **"Photoshop for developers" and "image toolchain" positioning.** The first implies creative-suite scope the thesis disclaims; the second describes sharp. Both invite the "it's a wrapper" dismissal.
- **The strategic goal "become the standard image primitive agents call".** No mechanism, no precedent, and it pulls design toward the MCP surface that the evidence says nobody wants.
- **Background removal, smart crop, and other semantic operations as v0.1 features.** Useful later as deterministic inputs to re-crop; not needed to test the core thesis.
- **Electron vs. Tauri, React vs. Svelte, libvips binding strategy.** All moot until the CLI proves demand. The technical hypothesis section should be shelved, not decided.

### Attractive ideas that are distractions

- The "132 files analyzed, 117 recommended for WebP, estimated 68% savings" dashboard. Nice demo; calibreapp's PR comment already delivers the substance for free.
- "Adjust individual exceptions through natural language." Editing a YAML line is faster and is what developers do.
- Undo/history in a GUI. Git is the undo.
- The plan-then-preview-then-apply loop for single images. The agent already does this and the developer already trusts it for one-offs.

### The smallest product that tests the core thesis

The core thesis, stripped of its surfaces, is: **developers will adopt an enforced, reproducible image policy for their repositories, and some teams will pay to review and approve automated image changes in their PRs.** That can be tested with a CLI, a GitHub Action, a static review report, and a skill. See "Recommended v0.1 Hypothesis".

---

## Alternative Wedges

Five narrower versions, ordered by the reviewer's estimate of their chances.

### Wedge A: `imglint` (image policy + autofix for repositories)

- **Target user:** maintainers of repos where many people commit images outside a framework pipeline: docs sites, design systems, marketing sites on plain static hosts, OSS projects with README screenshots, monorepos with `public/` folders.
- **Core workflow:** `.imgdev.yml` (or `.imglintrc`) with per-glob rules (maxWidth, maxBytes, formats, aspect, metadata policy, no-upscale); `imglint check` fails pre-commit or CI with a readable table; `imglint fix` applies deterministic, idempotent, reproducible transforms and writes a provenance marker; `imglint report` emits a static HTML before/after page with exceptions first.
- **Form factor:** single static binary (Rust or Go over libvips), `pre-commit` hook, GitHub Action, SKILL.md for Claude Code and Codex.
- **Why it might be stronger:** it is the only unoccupied piece of the thesis; it is the "contract" layer that agents cannot provide and that vendors explicitly say prose cannot enforce; it lives where developers already are (CI, PR); it ships in a form (single binary, action, skill) that the research shows wins distribution; it can be built by one person in weeks, not quarters.
- **What we lose:** the GUI, NL, and MCP stories; the "workbench" identity; any claim to be a category. Also the WordPress segment, which does not work in git.

### Wedge B: "Chromatic for images" (hosted PR review of image changes)

- **Target user:** engineering teams already paying for visual regression or bundle-size gating.
- **Core workflow:** GitHub App comments on every PR that touches images with a before/after grid, per-file size and dimension deltas, perceptual scores (SSIMULACRA2/DSSIM), policy violations, and an approve/reject per image; history and exceptions persist across PRs; policy inherited across repos in an org.
- **Form factor:** GitHub App + hosted web review UI; Wedge A's CLI as the local engine.
- **Why it might be stronger:** it is the only shape with a demonstrated recurring-revenue precedent ($100-700/mo per org); the data (history, approvals) becomes the moat the thesis lacks; it is what the thesis's "visual review of deterministic automation" actually means in practice.
- **What we lose:** local-first purity (the review layer is hosted); the individual-developer audience as customers (they stay free users); simplicity. It also cannot be the first thing built: it needs Wedge A to exist and a handful of teams to want it.

### Wedge C: Agent verification kit (the "eyes and ruler" for coding agents)

- **Target user:** developers using Claude Code, Codex, Gemini CLI, or Cursor for image work.
- **Core workflow:** a CLI + SKILL.md that, after any transform, produces (a) a structured JSON result (bytes, dimensions, format, SSIM vs. source, face/saliency box vs. crop rect, policy compliance), (b) a 1568 px labeled before/after contact sheet with the crop rectangle drawn, in a format the agent's vision can read (PNG, never AVIF), so the agent can review a batch in one image, and (c) idempotence markers so re-runs do not re-encode.
- **Form factor:** CLI + skill, published to the Claude Code and Codex marketplaces and awesome-copilot; no GUI; no server.
- **Why it might be stronger:** it targets the documented, current agent gaps (AVIF blindness, 5 MB cap, approximate localization, guessed settings, chance-level artifact judgment) rather than competing with the part agents already do well; it gets more valuable as agents become the primary caller; it is the one thing the MCP research found genuinely unbuilt; it is an afternoon of sharp to prototype and a distribution play thereafter.
- **What we lose:** any direct revenue (this is free by nature); the human-facing product. Highest risk of being absorbed by an official Anthropic or OpenAI skill.

### Wedge D: Figma-to-repo asset handoff with budgets

- **Target user:** product teams where designers export assets that developers then commit.
- **Core workflow:** export from Figma (via the Figma MCP `download_assets` or a plugin) straight into the repo, applying the repo's `.imgdev.yml` (formats, KB budgets, responsive sets, naming) and opening a PR with the review report.
- **Form factor:** Figma plugin + Wedge A's CLI.
- **Why it might be stronger:** TinyImage proves teams pay $20/seat/mo for KB-targeted export inside Figma; Figma's own MCP cannot export WebP/AVIF or hit size targets (users were still requesting this in January 2026); it connects the policy to the moment assets are born.
- **What we lose:** everyone who does not use Figma; the batch-repo story. Also depends on Figma's plugin economics and API stability.

### Wedge E: Honest small utility (the Zipic/Retrobatch lane)

- **Target user:** individual developers and prosumers who want a local batch tool with presets, CLI, folder watch, and a comparison view.
- **Core workflow:** drop a folder, pick a preset, review, apply; `$29-49` one-time.
- **Form factor:** native desktop app (Tauri), CLI, Shortcuts/Raycast integration.
- **Why it might be stronger:** it is an honest business at a known price point; Retrobatch and Zipic show a solo developer can sustain it; no venture expectations.
- **What we lose:** any claim to being a developer toolchain, agent primitive, or team product; recurring revenue; growth. Zipic already exists and ships most of this for $29.99. Listed for completeness; not recommended.

Recommended sequence if proceeding: **A first, with C's contact-sheet and structured-result outputs built into A from day one (they are the same engine), then B only if A is adopted and teams ask.** D is an optional channel later. E is a fallback, not a plan.

---

## Recommended v0.1 Hypothesis

This is the smallest product that tests the most important assumptions. It is not a PRD.

**Target user:** a maintainer of a repository where images are committed by several people outside a framework image pipeline (docs site, design system, marketing site on a static host, OSS project, monorepo `public/` folder), who already uses pre-commit hooks or GitHub Actions and at least one coding agent.

**Primary job:** "Keep every image in this repo compliant with our rules without anyone thinking about it, and let me see what the automation did before it lands."

**Core interaction:**

1. `imgdev init` writes a starter `.imgdev.yml` after scanning the repo (defaults derived from what is already there: max width, byte budget per glob, formats in use).
2. `imgdev check` runs locally, in pre-commit, and in CI; fails with a table of violations (file, rule, actual vs. allowed, suggested fix).
3. `imgdev fix` applies deterministic, idempotent transforms: resize with no upscale, format conversion by policy (WebP unless transparency, AVIF optional), byte-budget search with a perceptual floor (SSIMULACRA2 or DSSIM), metadata policy, attention crop only when an aspect rule requires it. Writes a provenance marker (hash of source + recipe + encoder versions) so re-runs skip compliant files.
4. `imgdev report` writes a static HTML page: exceptions first (anything that could not meet policy, any crop, any lossy step above a threshold), then a before/after grid with size and dimension deltas and a swipe compare per image. Opens in the browser. Also emits a 1568 px labeled contact sheet PNG and a JSON summary for agents.
5. A GitHub Action wraps `check` and `fix` and posts the report summary as a PR comment.
6. A SKILL.md teaches Claude Code and Codex to run `imgdev check` before committing images, to author `.imgdev.yml` from natural language, and to read the JSON and contact sheet after `fix`.

**What makes the demo compelling:** open a real repo with 300 mixed images, run `imgdev check`, see 41 violations in two seconds, run `imgdev fix`, run `imgdev report`, and see the three crops that need a human decision at the top of the page, with every other change verifiably lossless or under the perceptual floor. Then run `imgdev fix` again and watch it do nothing. Then ask Claude Code to add an OG image to the repo and watch it run `imgdev check` unprompted because the skill told it to.

**What to leave out:** any GUI beyond the static report; natural language inside the tool; MCP; plugins; generative operations; background removal; provider abstraction; accounts; hosted anything; Pro/Teams tiers; Electron, Tauri, React, or any framework decision; "repo awareness" beyond globs and git status; responsive variant generation (frameworks do it; add only if users ask); Windows support if it slows the first release.

**Technical constraint that matters for the test:** single static binary with libvips linked in (Rust via libvips bindings, or Go as Squish did), installable with one `curl` or `brew` line and runnable in a GitHub Action without `npm install`. If the tool requires Node, it is competing with `npx sharp-cli` on its own turf.

**What success would look like in 90 days after a public release:**

- At least 25 repositories not owned by the founder have `imgdev check` in CI or pre-commit, and at least 15 of them still have it 30 days after adding it.
- At least 5 of those repos have run `imgdev fix` more than three times (evidence of recurring, not one-time, use).
- At least 3 unsolicited requests for something that looks like Wedge B (hosted history, approvals in the PR, org-wide policy), or at least one team asking how to pay.
- The report page is opened after at least 40% of `fix` runs (instrument locally with opt-in telemetry, or infer from the GitHub Action comment link clicks). If nobody opens the report, the "visual review" half of the thesis is dead.
- The skill is installed from a marketplace at least 200 times and shows up in at least one third-party "agent image workflow" write-up.

If those numbers are not reached, the product is optimizt: useful, small, and not a business.

---

## Assumptions Requiring Human Validation

Questions that web research and reasoning cannot answer, phrased so they can become interview questions, landing-page tests, or prototype experiments.

**Frequency and segment**

1. In the last 30 days, how many times did you personally resize, crop, convert, or compress an image for a project? What tool did you use each time? (Interview; expect "one or two, with Squoosh or Claude" from framework developers and "daily, in the media library" from WordPress developers.)
2. When was the last time an image in your repo was wrong (too large, wrong format, bad crop) and it reached production or a PR reviewer? What did it cost? (Interview; tests whether the problem is felt or theoretical.)
3. Who commits images to your repository besides you? (Interview; the wedge depends on multi-committer repos.)
4. For WordPress and agency developers specifically: do any of your client images ever live in git, or do they all live in the media library? Would a git-side tool ever touch your workflow? (Interview; likely disqualifies the segment the founder knows best.)

**Policy and enforcement**

5. Show a developer a `.imgdev.yml` and a CLAUDE.md paragraph saying the same thing. Which would they add to their repo, and why? (Prototype test; tests whether "policy as config" beats "policy as prose" for the user, not just for the agent.)
6. If `imgdev check` failed a teammate's PR because a screenshot was 900 KB, would the team keep the gate or remove it within a month? (Interview or trial; the Imgbot and Image Checker numbers suggest removal.)
7. Do you already use `check-added-large-files` or any size guard? If so, what does it miss that you care about? (Interview; if the answer is "nothing", the policy wedge is dead.)

**Review**

8. After an automated optimization pass, did you look at the images? If yes, how, and did you ever reject one? (Interview; if nobody reviews, the before/after report is a feature nobody uses.)
9. Show the static report page after a real `fix` run. Does the user open it, scroll past the exceptions, or close it? Does it change any decision? (Prototype test with screen recording.)
10. Would you rather see the before/after in the PR (GitHub comment) or locally before committing? (Interview; decides whether Wedge B or the local report is the primary surface.)

**Agents**

11. When you ask Claude Code or Codex to optimize images, do you check the output? How? Have you ever caught it doing something wrong? (Interview; tests whether the documented agent gaps are felt.)
12. Would you install a skill that makes the agent run a policy check before committing images? Would you notice if it did not? (Marketplace test; install and retention counts.)

**Willingness to pay**

13. Landing page test for Wedge B: "Image review for pull requests: before/after, budgets, approvals. $99/mo per org." Measure sign-ups for early access against a control page describing the free CLI only.
14. Interview teams currently paying for Chromatic, Argos, or Percy: would they add an image-hygiene check to that bill, and would they prefer it inside their existing tool? (Tests whether the buyer exists and whether an incumbent absorbs it.)
15. For individuals: "Would you pay $29 once for a desktop review window?" versus "Would you pay $5/mo?" (Survey; expect near-zero on recurring.)

**Positioning**

16. Read three one-line descriptions ("image linter for your repo", "the image toolchain for developers", "Photoshop for people who would rather be coding") to developers and ask what each product does and whether they would install it. (Tests whether "toolchain" and "Photoshop" invite the wrapper or creative-suite dismissal.)

---

## Thesis Changes Recommended

Each recommendation references the relevant section of `01-product-thesis.md`.

| Classification | Thesis idea | Recommendation |
|---|---|---|
| **KEEP** | 6.1 Deterministic first, generative when necessary | Keep, and go further: v0.1 is deterministic only. The evidence (OpenAI masks are "guidance", Gemini has no seed, "every model degrades a face a little on each pass") confirms generative paths are a different product. |
| **KEEP** | 6.3 One operation model under GUI, CLI, recipe, agent | Keep the principle; drop the GUI from the list for now. One schema behind CLI, action, report, and skill. |
| **KEEP** | 6.4 Local-first by default | Keep as a prerequisite for trust. Stop describing it as a differentiator; every OSS tool and every Show HN launch is local. |
| **KEEP** | 6.6 Developer ergonomics over creative-suite completeness | Keep. Apply it to the product itself: a single binary and a YAML file are the ergonomic choice. |
| **KEEP** | 8 Non-goals list | Keep, and add the items under REMOVE below. |
| **KEEP** | 19.4, 19.7, 19.8, 19.10, 19.11 (deterministic, local-first, one model, useful despite AI, biggest threat is agents) | Keep; the research supports all five. |
| **MODIFY** | 1, 18 Positioning: "the image toolchain for developers", "Photoshop for developers", "image editing for people who would rather be coding" | Replace with something like "image policy and review for repositories" or "the image linter". "Toolchain" describes sharp; "Photoshop" invites creative-suite scope; "editing" is the wrong verb. The strongest existing line in the thesis is "the missing visual layer between ImageMagick and an AI coding agent", and even that should become "the missing contract layer". |
| **MODIFY** | 3.1 Primary user (front-end, full-stack, WordPress, agency, indie, founders, OSS, DevOps, content-heavy sites) | Narrow to maintainers of multi-committer repos with images outside a framework pipeline. Move WordPress and agency developers to "validate" (their images live in the media library, already served at upload time, and WP 7.1 moves processing into the browser). |
| **MODIFY** | 4 Jobs 1-6 | Reorder: Job 5 (policy compliance) becomes primary; Job 3 (visual review) becomes its companion; Job 4 (recipes) becomes the policy file; Job 6 (agents) becomes a skill and structured outputs; Jobs 1 and 2 (single-image spec, folder optimize) become consequences of `fix`, not the headline. |
| **MODIFY** | 5 Core interaction loop (open, describe, plan, preview, adjust, apply, save recipe, reproduce) | Replace with: init policy, check, fix, report, gate in CI, agent honors the same policy. Drop "describe" and "adjust through natural language" from the core loop. |
| **MODIFY** | 7 Leading MVP wedge and "magic" demo | Replace the desktop-workbench demo with the `check`/`fix`/`report`/idempotent-rerun/agent-honors-policy demo described in "Recommended v0.1 Hypothesis". |
| **MODIFY** | 10 Recipe and policy hypothesis | Keep `.imgdev.yml` and `check`/`fix`/`review`; drop the claim that a widely adopted format is a moat. A format is only defensible if something enforces it; make enforcement the product and the format its input. Add idempotence markers, provenance, and perceptual-metric targets to the schema. |
| **MODIFY** | 12 Monetization | Remove Pro-as-hosted-AI. Replace Teams with a hosted CI review layer priced on volume (Chromatic pattern). Keep free/open core. Defer API tier until requested. Treat BYOK as the permanent free tier, not a funnel. |
| **MODIFY** | 13.2 Potential defensibility (eight items) | Reduce to one candidate: accumulated review history and approvals in CI. Reclassify recipe format, repo awareness, plugins, MCP, local-first, community, and open source as distribution or prerequisites, not moats. |
| **MODIFY** | 13.3 Strategic goal "when an agent needs to manipulate images it chooses this tool" | Replace with "when an agent commits images, it runs `imgdev check` because the repo's skill and CI say so." The contract is enforceable; the primitive is not. |
| **MODIFY** | 14 Risk 1 (agents make it unnecessary) | Rewrite from future tense to present tense: agents already do one-off image work well and developers like it. Position only against the documented gaps (guessed settings, non-idempotence, format blindness, unreliable artifact judgment, no enforcement), never against the one-off use case. |
| **REMOVE** | 5, 7, 9 Desktop GUI application, Electron/Tauri decision, "fast visual browser" | Remove from v0.1 entirely. A static HTML report and a PR comment deliver the visual review. Revisit only if report-open rates and user requests justify it. |
| **REMOVE** | 2.3, 5, 7 Natural-language intent as a core product feature | Remove from the product. Put it in the SKILL.md (agent authors the YAML from a sentence). |
| **REMOVE** | 4 Job 6, 13.2.5, 13.3 MCP server as a primary interface | Remove from v0.1. Ship a skill. Add MCP later only for shell-less clients and only to return review tiles inline. |
| **REMOVE** | 13.2.6 Plugins and extensibility | Remove until there are users to extend it. |
| **REMOVE** | 6.5 Interchangeable AI providers | Remove; there is no AI in v0.1 to abstract. |
| **REMOVE** | 6.1, 12 Generative operations (outpainting, object removal, background generation, segmentation, generative fill/expand) | Remove from the roadmap through 1.0. Different product, different competitors, credit economics the thesis says it does not want. |
| **REMOVE** | 12 Pro tier (hosted AI, model routing, cloud recipe sync, project history, remote jobs) | Remove. Each element is margin-negative, unwanted, or a different product. |
| **REMOVE** | 12 Teams tier as designed (roles, permissions, centralized AI, asset standards) | Remove; replace with the hosted review layer under MODIFY 12. |
| **REMOVE** | 12 API/automation tier, remote batch, hosted CI infrastructure | Remove until requested. |
| **REMOVE** | 9 Technical hypothesis section (libvips vs. ImageMagick vs. GEGL, Sharp vs. direct bindings, Electron vs. Tauri, React/Vue/Svelte) | Shelve. The only technical decision v0.1 needs is "single static binary with libvips, no Node runtime". |
| **REMOVE** | 13.2.2 "Repository awareness: understanding how assets are actually used in software projects" | Remove as a moat and as a v0.1 feature beyond globs and git status. Agents and frameworks already have the deep version. |
| **ADD** | (new) Perceptual-quality targeting (SSIMULACRA2, DSSIM, Butteraugli) as the definition of "deterministic quality" | Add. Sharp 0.35 just adopted SSIMULACRA2 internally for AVIF; almost no CLI exposes a perceptual target; Squoosh's dead auto-optimizer did. This is the most credible technical hook the research found. |
| **ADD** | (new) Idempotence and provenance markers | Add. Re-running `fix` must do nothing on compliant files; every output should carry a hash of source + recipe + encoder versions. This is the single clearest deficit of agent-written scripts. |
| **ADD** | (new) Structured JSON results and a review-resolution contact sheet for agents | Add to v0.1. Bytes, dimensions, SSIM, saliency/face box vs. crop rect, policy compliance per file; plus a labeled 1568 px PNG before/after grid. The one genuinely unbuilt agent-facing feature found. |
| **ADD** | (new) Explicit "what agents cannot see" handling | Add. Convert AVIF/HEIC/TIFF/SVG and oversized outputs to review-safe PNG tiles so an agent's vision can inspect them. |
| **ADD** | (new) Pre-commit hook and GitHub Action as first-class distribution | Add. This is where the product lives. |
| **ADD** | (new) Kill criteria and 90-day success metrics | Add the ones below to the thesis so the decision is pre-committed. |
| **VALIDATE** | 3.1, 14 Risk 2 Frequency by segment | Run the interviews in "Assumptions Requiring Human Validation" 1-4 before writing a line of code. |
| **VALIDATE** | 4 Job 3, 14 Risk 3 Whether anyone reviews automated image changes | Prototype the static report with a real repo and watch whether people open it and whether it changes a decision. |
| **VALIDATE** | 10 Whether teams keep an image gate in CI | Trial `check` in ten friendly repos and measure 30-day retention of the gate. |
| **VALIDATE** | 12 Whether any team will pay for hosted review history | Landing-page test for Wedge B against a free-CLI control. |
| **VALIDATE** | 3.1 WordPress/agency segment fit | Interview five agency developers on whether any project image ever lives in git; expect "no". |
| **VALIDATE** | 15 Competitive question "Could IDE vendors or agent vendors absorb this?" | Watch Anthropic's bundled skills (`/run`, `/verify`) and OpenAI's plugins repo for an official media-processing skill; that is the single event most likely to end the agent-facing wedge. |

---

## Kill Criteria

Concrete findings that should cause abandonment rather than rationalization. Each is stated so that it can be observed, not argued.

**Before building (interview and desk phase, 2-4 weeks):**

1. Fewer than 4 of 12 interviewed developers in the target segment (multi-committer repos, images outside a framework pipeline) can name a specific incident in the last 90 days where a wrong image reached a PR or production. The problem is theoretical.
2. More than half of interviewees already use `check-added-large-files` or an equivalent and say it catches everything they care about. The policy wedge is a one-line YAML away from solved.
3. When shown `.imgdev.yml` and an equivalent CLAUDE.md paragraph, fewer than half would add the YAML. Policy-as-config does not beat policy-as-prose for the user.
4. Anthropic or OpenAI ships an official image/media processing skill with a verification step, or a major framework (Next, Astro) or GitHub ships repo-side image linting natively. Check before starting and monthly thereafter.

**After a public v0.1 (90 days):**

5. Fewer than 25 non-founder repositories add `imgdev check` to CI or pre-commit, or fewer than 60% of those keep it 30 days later. The gate is removed the first time it blocks someone, exactly as the Imgbot and Image Checker numbers predict.
6. The report page is opened after fewer than 25% of `fix` runs. Nobody reviews automated image changes; the "visual review" half of the thesis is dead, and the product collapses to optimizt.
7. Zero unsolicited requests for hosted history, PR approvals, or org-wide policy, and zero teams asking how to pay. There is no Wedge B, and therefore no business.
8. The skill's marketplace installs are under 100 in 90 days, or a community SKILL.md (jezweb, danielrosehill, awesome-copilot) is cited more often than it in agent-workflow write-ups. The agent-facing wedge has been absorbed by prompt packs.
9. Maintenance load (libvips CVEs, codec updates, platform builds) exceeds one day a week for one person before any of 5-8 are met. This is what killed Squoosh CLI, imagemin, and smartcrop.js.

**Any time:**

10. The founder finds themselves adding a GUI, natural language, MCP, or plugins before criteria 5-7 are met. That is the thesis reasserting itself over the evidence, and it is the most likely failure mode.

If criteria 5, 6, and 7 are all met at 90 days, proceed to Wedge B. If exactly one is met, keep the CLI as an open-source utility and stop investing founder time. If none are met, archive it.

---

## Final Recommendation

Do not build Rasterwright as described in `01-product-thesis.md`. The desktop workbench, the natural-language layer, the MCP server, the plugin system, the Pro tier, and the "image toolchain for developers" positioning are each either already free, already shipped by someone with distribution, already built and ignored by one-to-fourteen-star predecessors, or documented as margin-negative by the founders who tried them. The thesis's own Risk 1 is not a future risk; coding agents already do one-off image work well and developers like it.

Do spend two to four weeks and roughly zero dollars testing the one seam the research could not find an incumbent for: **an enforced, reproducible image policy for repositories, with a batch before/after report, shipped as a single binary, a pre-commit hook, a GitHub Action, and an agent skill.** Run the interviews in "Assumptions Requiring Human Validation" 1-7 first. If fewer than a third of target-segment developers can name a real incident, stop there and write it up as a learning.

If the interviews pass, build the v0.1 described above in the smallest possible form (no Node runtime, no GUI, no NL, no MCP), release it publicly, instrument report-open rates and gate retention, and hold yourself to the 90-day kill criteria. Build the contact sheet and structured JSON outputs from day one; they cost nothing extra and they are the only agent-facing feature the research found genuinely unbuilt. Design the policy schema with idempotence markers and perceptual-quality targets, because those are the two properties agent-written scripts demonstrably lack.

If the 90-day numbers are hit, and only then, build the hosted PR review layer (Wedge B) and price it like Argos, not like Cloudinary. That is a small, defensible, two-to-four-person business with a real precedent. It is not a venture-scale company, and the thesis should stop being designed as if it were one.

If the numbers are not hit, keep the CLI on GitHub as a useful open-source utility, accept that it will be optimizt (a few hundred stars, a few thousand weekly downloads, quietly appreciated), and put the founder's time elsewhere. That outcome is not a failure; it is the most likely outcome, and it is worth knowing in 90 days rather than 18 months.

The single most important change to the thesis: **stop building a product for the developer and start building a contract for the repository.** Developers already have Claude Code and sharp. Repositories have nothing.

---

## Research Notes / Sources

Full per-area research notes with complete source lists were produced during this review (libraries/CLIs/OSS; cloud platforms; creative incumbents; AI assistants and agents; MCP and skills; CI/build/IDE and frequency; desktop utilities and monetization). The sources below are the ones that carry the review's key claims.

### Engine, CLIs, open-source precedents

- sharp: https://sharp.pixelplumbing.com/api-output/ (no max-bytes option), https://sharp.pixelplumbing.com/changelog/0.35.0/ (SSIMULACRA2 AVIF), npm downloads API (93.85M/week, 2026-08-23 to 08-29)
- libvips: https://www.libvips.org/2025/12/04/What's-new-in-8.18.html, libvips ChangeLog (8.19 point-of-interest smartcrop)
- ImageMagick: https://usage.imagemagick.org/formats/ (`jpeg:extent`), https://imagemagick.org/webp/ (`webp:target-size`)
- cwebp `-size`: https://developers.google.com/speed/webp/docs/cwebp; avifenc `--target-size`: https://raw.githubusercontent.com/AOMediaCodec/libavif/main/doc/avifenc.1.md; jpegoptim `-S`: https://github.com/tjko/jpegoptim; caesiumclt `--max-size`: https://github.com/Lymphatus/caesium-clt
- Squoosh: https://github.com/GoogleChromeLabs/squoosh (no commits since 2024-08-19), https://registry.npmjs.org/@squoosh/cli (maintenance notice, Butteraugli auto-optimizer)
- Squish: https://github.com/keif/image-optimizer (1 star)
- bthurlow/imagemagick-mcp: https://github.com/bthurlow/imagemagick-mcp (57 tools, 2 stars)
- imagecli: https://github.com/mlaprise/imagecli (5 stars)
- optimizt: https://github.com/343dev/optimizt (184 stars); picopt: https://github.com/ajslater/picopt; rimage: https://github.com/SalOne22/rimage; oxipng: https://github.com/oxipng/oxipng; IMGo: https://github.com/meowtec/Imagine
- smartcrop.js (last commit 2024-03-16): https://github.com/jwagner/smartcrop.js; rembg: https://github.com/danielgatis/rembg
- ssimulacra2: https://github.com/cloudinary/ssimulacra2; dssim: https://github.com/kornelski/dssim; odiff: https://github.com/dmtrKovalenko/odiff; reg-suit: https://github.com/reg-viz/reg-suit
- Jampack: https://github.com/divriots/jampack; vite-imagetools: https://github.com/JonasKruckenberg/imagetools; eleventy-img: https://www.11ty.dev/docs/plugins/image/; unpic: https://unpic.pics/

### CI, build-time, IDE, frequency

- calibreapp/image-actions: https://github.com/calibreapp/image-actions; Imgbot: https://github.com/marketplace/imgbot, https://github.com/dabutvin/ImgBot (last push 2025-01-28); Image Checker: https://github.com/marketplace/actions/image-checker (1 star); pre-commit-hooks: https://github.com/pre-commit/pre-commit-hooks
- Vercel pricing: https://vercel.com/changelog/faster-transformations-and-reduced-pricing-for-image-optimization, https://vercel.com/changelog/changes-to-vercel-image-optimizations; HN thread https://hn.algolia.com/api/v1/items/43687431; HowdyGo: https://www.howdygo.com/blog/cutting-howdygos-vercel-costs-by-80-without-compromising-ux-or-dx
- Framework docs: https://nextjs.org/docs/app/api-reference/components/image, https://docs.astro.build/en/guides/images/, https://svelte.dev/docs/kit/images, https://image.nuxt.com/get-started/providers, https://gohugo.io/content-management/image-processing/
- WordPress: https://make.wordpress.org/core/2022/09/11/webp-in-core-for-6-1/, https://make.wordpress.org/core/2024/02/23/wordpress-6-5-adds-avif-support/, https://make.wordpress.org/core/2026/07/22/client-side-media-processing-in-wordpress-7-1/; plugin pages on wordpress.org for wp-smushit, ewww-image-optimizer, imagify, shortpixel-image-optimiser, optimole-wp, webp-uploads
- Web Almanac: https://almanac.httparchive.org/en/2024/media, https://almanac.httparchive.org/en/2024/performance, https://almanac.httparchive.org/en/2025/page-weight
- GitHub image diff: https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files, https://github.blog/changelog/2025-07-31-pull-request-files-changed-public-preview-experience-july-31-updates/; VS Code swipe diff closed: https://github.com/microsoft/vscode/issues/185417
- VS Code marketplace: Image preview (kisstkondoros.vscode-gutter-preview), Luna Paint (Tyriar.luna-paint), TinyPNG (andi1984.tinypng), Image Manager (minko.image-manager); JetBrains plugins API for PNG Optimizer, TinyPNG, WebP converter
- HN: https://news.ycombinator.com/item?id=46776752 (Automating Image Compression, Jan 2026); Algolia searches for "image optimization" stories 2024-2026 and "Ask HN" image workflow (zero hits since 2023)

### Cloud media platforms

- Cloudinary: https://cloudinary.com/documentation/cloudinary_llm_mcp, https://cloudinary.com/blog/cloudinary-mcp-server, https://cloudinary.com/documentation/programmable_media_release_notes, https://cloudinary.com/pricing, https://github.com/cloudinary/cloudinary-cli, https://github.com/cloudinary-devs/skills, https://github.com/cloudinary/mcp-servers; Cloudinary Agents (May 2026) via aijourn.com; $100M ARR (BusinessWire, Jan 2022) and $2B valuation (Forbes, Feb 2022) via search summaries
- Cloudflare Images: https://developers.cloudflare.com/images/pricing/, https://blog.cloudflare.com/background-removal/
- ImageKit: https://imagekit.io/plans, https://imagekit.io/docs/mcp-server
- Transloadit MCP: https://transloadit.com/blog/2026/02/transloadit-mcp-server/
- Photoroom: https://www.photoroom.com/api/pricing, https://docs.photoroom.com/image-editing-api-plus-plan/output-size.md, https://www.photoroom.com/api/claude; ARR via https://sacra.com/c/photoroom/
- TinyPNG: https://tinify.com/pricing/api; Bunny: https://bunny.net/pricing/optimizer/; imgix: https://www.imgix.com/pricing; Uploadcare: https://uploadcare.com/pricing/; Netlify: https://docs.netlify.com/build/image-cdn/overview/
- Embedded editor SDKs: https://img.ly/pricing/, https://pqina.nl/pintura/pricing/

### Creative incumbents

- Photoshop AI Assistant beta: https://www.photoshopnews.com/2026/03/12/adobe-photoshop-ai-assistant-public-beta, https://www.photoshopnews.com/2026/04/04/whats-new-photoshop-2026-ai-assistant-generative-updates
- Photoshop API / Firefly Services: https://developer.adobe.com/firefly-services/docs/photoshop/, https://sudomock.com/blog/adobe-photoshop-api-pricing-2026 (v1 EOL, v2 enterprise rate card)
- Adobe MCP (secondhand): https://mcpservers.org/remote-mcp-servers/adobe-creativity, https://www.usecarly.com/blog/adobe-mcp/
- Photoshop batch WebP: https://community.adobe.com/t5/photoshop-ecosystem-discussions/batch-process-images-to-webp/td-p/14107449
- Canva MCP: https://www.canva.dev/docs/mcp/, https://www.canva.dev/blog/developers/canva-and-coding-agents-platforms/, https://docs.dust.tt/docs/canva-mcp; Affinity free: https://www.cgchannel.com/2025/10/check-out-canvas-new-perpetually-free-affinity-software/
- Photopea API: https://www.photopea.com/api/, https://www.photopea.com/learn/scripts
- Figma MCP: https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/; TinyImage: https://www.hypermatic.com/tinyimage/, https://docs.hypermatic.com/tinyimage/tutorials/compress-figma-image-exports-to-file-size-targets
- GIMP MCP: https://github.com/maorcc/gimp-mcp, https://github.com/abelduarte/gimp-mcp

### AI assistants and coding agents

- Claude vision limits: https://platform.claude.com/docs/en/build-with-claude/vision; Claude Code skills, memory, workflows, Chrome, computer use: https://code.claude.com/docs/en/skills, https://code.claude.com/docs/en/memory, https://code.claude.com/docs/en/common-workflows, https://code.claude.com/docs/en/chrome, https://code.claude.com/docs/en/computer-use
- Claude Code image size bug: https://github.com/anthropics/claude-code/issues/27611, https://getinvoke.dev/learn/claude-code-image-too-large/
- Codex image workflows: https://codex.danielvaughan.com/2026/03/28/codex-cli-image-workflows/, https://codex.danielvaughan.com/2026/04/27/codex-cli-image-generation-gpt-image-2-visual-development-workflows/; Codex skills: https://learn.chatgpt.com/docs/build-skills; imagegen skill: https://github.com/openai/skills/blob/main/skills/.system/imagegen/SKILL.md
- OpenAI image API (masks as guidance): https://developers.openai.com/api/docs/guides/image-generation; GPT Image timeline: https://en.wikipedia.org/wiki/GPT_Image
- Gemini image generation (no seed, JPEG/PNG only): https://ai.google.dev/gemini-api/docs/image-generation; Gemini CLI read_file: https://geminicli.com/docs/tools/file-system/
- Cursor browser tool: https://cursor.com/docs/agent/tools/browser; Copilot vision and coding agent: https://github.blog/changelog/2026-07-30-github-copilot-in-visual-studio-code-july-2026-releases/, https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent; Cline tools: https://docs.cline.bot/exploring-clines-tools/cline-tools-guide
- VLM quality judgment: DistortBench https://arxiv.org/html/2604.19966v1; Q-Bench-Portrait https://arxiv.org/abs/2601.18346; VLIC https://arxiv.org/abs/2512.15701
- Local models: https://builderai.tools/blog/ai-image-editing-flux-kontext-qwen-image-edit-step1x, https://invideo.io/blog/ai-background-removal-models/, https://insiderllm.com/guides/vision-models-locally/
- AGENTS.md field guide: https://www.iuriio.com/blog/posts/2026/05/agents-md-field-guide-2026
- HN developer anecdotes via Algolia API: arrowsmith (2025-08-02), arjie (2025-11-04, 2025-12-27), delaminator (2025-10-17), khasan222 (2026-04-13), kaijia (2025-12-08); Nano Banana determinism complaints (peetle, BeetleB, echelon, Oct-Nov 2025)

### MCP servers and agent skills

- ImageSorcery: https://github.com/sunriseapps/imagesorcery-mcp, https://pypistats.org/api/packages/imagesorcery-mcp/recent; OpenCV MCP archived: https://github.com/GongRzhe/opencv-mcp-server; others: https://github.com/piephai/mcp-image-optimizer, https://github.com/BoomLinkAi/image-worker-mcp, https://github.com/maoxiaoke/mcp-media-processor, https://github.com/ncipollo/magick-mcp
- Official registry search: https://registry.modelcontextprotocol.io/v0/servers?search=image&limit=100; Smithery, Glama, PulseMCP listings
- Anthropic skills repo and guidance: https://github.com/anthropics/skills, https://claude.com/blog/skills-explained; awesome-copilot ImageMagick skill: https://mcpservers.org/agent-skills/github/image-manipulation-image-magick
- Community skills: https://github.com/jezweb/claude-skills/blob/main/plugins/design-assets/skills/image-processing/SKILL.md, https://github.com/danielrosehill/Claude-Image-Production-Plugin, https://github.com/claudeskills/img-to-webp, https://github.com/oaustegard/claude-skills/blob/main/processing-images/SKILL.md, https://www.prodfeat.ai/en/blog/2026-02-22-claude-code-image-processing-skill, https://github.com/ComposioHQ/awesome-claude-skills
- MCP vs CLI token economics: https://www.firecrawl.dev/blog/mcp-vs-cli, https://www.mindstudio.ai/blog/mcp-vs-cli-ai-agents-token-costs-when-to-use, https://danielmiessler.com/blog/anthropic-downplays-mcps, https://www.shareuhack.com/en/posts/mcp-vs-skill-vs-cli-guide
- Playwright MCP: https://github.com/microsoft/playwright-mcp; visual diff MCPs: https://github.com/byzkhan/difflens, https://github.com/leky90/mcp-image-compare-server
- Popularity lists: https://mcpmanager.ai/blog/most-popular-mcp-servers/, https://awesomeclaude.ai/top-mcp-servers
- Vendor MCP npm downloads (last month): @transloadit/mcp-server 2,828; @bannerbear/mcp 1,430; @cloudinary/asset-management-mcp 869; @imagekit/api-mcp 406; sharp 361.5M; @playwright/mcp 24.4M

### Desktop utilities and monetization

- Retrobatch: https://flyingmeat.com/retrobatch/, https://flyingmeat.com/blog/archives/2023/11/retrobatch_2.html; ImageOptim API: https://imageoptim.com/api/pricing; Optimage: https://optimage.app/; JPEGmini: https://jpegmini.com/pricing; Squash: https://www.realmacsoftware.com/squash/press-kit/; Zipic: https://zipic.app/; Compresto: https://compresto.app/pricing; Upscayl: https://upscayl.org/pricing
- Show HN scans via Algolia API (image optimizer, batch image webp avif, image Mac app compress)
- Dev-tool pricing: https://www.git-tower.com/pricing, https://blog.kaleidoscope.app/2023/03/23/switching-to-subscription-pricing-for-kaleidoscope-4/, https://www.raycast.com/pricing, https://nova.app/buy/, https://www.capterra.com/p/233190/Polypane/pricing/
- BYOK evidence: https://zed.dev/blog/pricing-change-llm-usage-is-now-token-based, https://www.warp.dev/blog/warp-new-pricing-flexibility-byok, https://cursor.com/help/models-and-usage/api-keys, https://sacra.com/c/cline/, https://www.tanayj.com/p/the-gross-margin-debate-in-ai
- Open-core outcomes: https://sacra.com/c/n8n/, https://www.usebruno.com/pricing, https://hoppscotch.com/pricing, https://plus.excalidraw.com/pricing, https://penpot.app/pricing, https://tldraw.dev/pricing, https://imgproxy.net/pricing/, https://transloadit.com/pricing/
- Sponsorship: https://opencollective.com/libvips, https://opencollective.com/svgo
- Visual review CI pricing: https://www.chromatic.com/pricing, https://argos-ci.com/pricing, https://applitools.com/pricing/, https://www.browserstack.com/percy; adjacent: https://relative-ci.com/pricing, https://about.codecov.io/pricing/
- Segment spend: https://managewp.com/pricing, https://shortpixel.com/, https://www.pixelz.com/pricing/, https://www.vendr.com/marketplace/bynder (and brandfolder, frontify)

### Research gaps and unverified items

- WebSearch budgets were exhausted in every research pass; later evidence came from direct fetches and public APIs (GitHub, npm, PyPI, crates.io, HN Algolia). Reddit and X were not fetched directly. Stack Overflow and Google Trends were blocked from the research environment.
- Unverified: Cloudinary's current ARR; Voormedia/TinyPNG revenue; an official Uploadcare MCP; Adobe's MCP tool list and whether it reads local files (secondhand); Magnific's MCP; Retrobatch sales; Raycast and Warp ARR (third-party estimates); Cursor Teams BYOK surcharge; Lighthouse audit failure percentages; Affinity WebP/AVIF export; Photopea MAU; Windsurf, Kiro, and Amp local-image viewing; Florence-2 and smartcrop.js 2026 status; whether cjpegli exposes a target-size flag; the "hallucinated ImageMagick flags" complaint pattern (zero HN hits; could not be substantiated).
- The frequency evidence is the weakest part of this review. It rests on Web Almanac aggregates, plugin install counts, HN thread counts, and the adoption numbers of precedent tools. It does not include a single direct interview. The first four questions in "Assumptions Requiring Human Validation" exist to fix that before any code is written.
