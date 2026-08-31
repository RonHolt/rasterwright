# Working Product Thesis: The Image Toolchain for Developers

**Status:** Working product thesis — intentionally provisional  
**Stage:** Idea / pre-validation  
**Audience:** Founders, product reviewers, adversarial reviewers, technical architects, and future coding agents  
**Working category:** Developer image tooling  
**Working positioning:** *The image toolchain for developers.*

> **Important:** This document captures the strongest current version of the idea, not a set of final requirements. Any claim labeled as a hypothesis, assumption, or open question should be challenged. The purpose of this document is to make the idea concrete enough to critique without prematurely locking the product.

---

## 1. Executive Summary

Developers frequently need to manipulate images as part of building websites and software, but the available tools force them into workflows that are either too heavyweight, too cryptic, too manual, or too disconnected from visual feedback.

A developer who needs to resize a hero image, convert it to WebP, crop around the subject, strip metadata, hit a file-size target, generate responsive variants, or batch-process a directory typically chooses among:

- a full creative application such as Photoshop or GIMP,
- command-line tooling such as ImageMagick,
- project-specific scripts using Sharp/libvips,
- cloud media platforms,
- or a general-purpose LLM that improvises commands or image edits.

Each solves part of the problem, but none is optimized around the developer’s actual mental model: **“I know the outcome and constraints I need; I do not want to become an image-editing expert to get there.”**

The proposed product is a local-first image workbench for developers that combines:

- visual browsing and before/after previews,
- deterministic image transformations,
- natural-language intent,
- reusable declarative recipes,
- batch processing,
- repository awareness,
- CLI and API access,
- agent/MCP integration,
- and eventually CI enforcement.

The product is **not** intended to replace Photoshop for designers or Krita for artists. It is intended to make routine image work nearly frictionless for developers.

The central product principle is:

> **Visual when you need to see it.  
> Declarative when you need repeatability.  
> Scriptable when you need automation.  
> Conversational when you don’t remember the syntax.**

The AI itself is explicitly **not** the moat. The defensibility hypothesis is that the product can become the reliable developer image toolchain that humans and general-purpose agents both call: a combination of a strong operation model, recipe format, project policies, repo-aware workflows, visual review, CLI/CI integration, plugins, and ecosystem adoption.

The largest existential risk is that general-purpose coding agents become good enough at combining existing tools such as ImageMagick, Sharp, and libvips that developers do not need a dedicated product. The product must therefore be substantially faster, safer, more visual, more deterministic, and more reusable than ad-hoc agent-generated scripts.

---

## 2. The Problem

Image manipulation occupies an awkward gap in developer tooling.

Developers commonly need to:

- resize oversized assets,
- crop images to exact aspect ratios,
- optimize images for web delivery,
- convert between JPEG, PNG, WebP, AVIF, SVG, and related formats,
- reduce files below a specified byte size,
- normalize color spaces,
- strip metadata,
- preserve or remove transparency,
- generate responsive variants,
- create thumbnails,
- remove backgrounds,
- extend a canvas,
- reframe a crop around a subject,
- batch-process a directory,
- and enforce asset conventions across a repository.

These are often not creative tasks. They are **constraint-satisfaction tasks**.

The developer typically knows the desired result:

> “Make this 1600×900, keep the house visible, convert it to WebP, and keep it below 250 KB.”

The friction lies in translating that intent into the mechanics of an image editor or command-line utility.

### 2.1 Existing GUI applications are too heavyweight

Applications such as Photoshop and GIMP expose enormous capability, but routine developer work often requires only a small fraction of it.

The developer must remember or rediscover:

- which tool or menu performs the operation,
- how the application defines crop vs. canvas resize,
- export settings,
- resampling choices,
- color-profile behavior,
- transparency behavior,
- layer semantics,
- and application-specific terminology.

For someone who edits images occasionally rather than professionally, each visit can involve relearning the software.

### 2.2 Command-line tools are powerful but cognitively expensive

ImageMagick and similar tools are exceptionally capable and excellent for automation, but their interfaces optimize for expressiveness rather than discoverability.

A developer may know exactly what should happen while still needing to look up syntax, flags, geometry rules, gravity behavior, escaping, codecs, and quality settings.

The workflow often becomes:

1. search documentation,
2. construct a command,
3. run it,
4. open the output elsewhere,
5. notice a bad crop or quality issue,
6. change parameters,
7. rerun,
8. inspect again.

The automation is powerful, but the visual feedback loop is poor.

### 2.3 General-purpose LLMs improve syntax but not the workflow

An LLM can write an ImageMagick command or a Sharp script, which eliminates some syntax lookup.

However, this still tends to be an improvised workflow:

- the model has to select a tool,
- construct code or shell syntax,
- run the transformation,
- inspect results,
- reason about failures,
- revise the script,
- and often leave behind one-off code.

The LLM is acting as a temporary integration layer rather than using a purpose-built image system.

### 2.4 Generative image tools solve a different problem

Modern image generators and multimodal assistants are increasingly capable of modifying images through natural language.

However, many developer tasks should **not** be generative.

Resizing, cropping, format conversion, metadata removal, target file size, color conversion, and responsive image generation should be deterministic and inspectable. Re-generating pixels for those operations can introduce unnecessary changes and reduce trust.

The desired model is:

**use deterministic operations whenever deterministic operations can solve the problem; invoke generative AI only when semantic image understanding or pixel synthesis is actually required.**

---

## 3. Target User

### 3.1 Primary user

A software or web developer who periodically needs to manipulate image assets but does not consider image editing a core creative discipline.

Representative users include:

- front-end developers,
- full-stack developers,
- WordPress developers,
- agency developers,
- indie hackers,
- technical founders,
- open-source developers,
- DevOps/build engineers managing asset pipelines,
- and developers maintaining content-heavy websites.

### 3.2 User mindset

The target user tends to think in specifications:

- “maximum width 2400 px,”
- “16:9 hero,”
- “under 300 KB,”
- “WebP unless transparency is required,”
- “generate 1x and 2x versions,”
- “don’t upscale,”
- “preserve the subject,”
- “apply this to the entire folder.”

This is meaningfully different from a creative professional who may think primarily in terms of masks, brushes, paths, blending, color grading, or compositional adjustments.

### 3.3 Initial non-user

The initial product is **not primarily for**:

- professional photographers,
- graphic designers deeply invested in Adobe workflows,
- digital painters,
- illustrators,
- prepress professionals,
- or users who need exhaustive Photoshop feature parity.

Those markets may eventually benefit from the product, but attempting to win them initially would dramatically broaden scope.

---

## 4. Jobs To Be Done

The current hypothesis is that the product should excel at a small set of recurring developer jobs.

### Job 1: Make an image fit a technical requirement

> “Make this image 1600×900, keep the subject framed well, output WebP, and stay under 250 KB.”

The user should be able to express the outcome rather than manually translate it into image-editor operations.

### Job 2: Optimize a set of assets for a website or application

> “Normalize everything in this folder for the web. Don’t upscale. Max width 2400 px. Prefer WebP. Preserve transparency. Strip metadata.”

The system should preview the expected transformations, estimated size savings, and exceptional cases before applying them.

### Job 3: Visually review a transformation before committing it

The user should be able to compare original and output without switching applications or manually reopening generated files.

For subjective operations such as cropping, compression, background removal, or generative expansion, the visual feedback loop should be immediate.

### Job 4: Turn a successful one-off transformation into a reusable recipe

A user who gets a result right once should be able to reuse it across:

- another file,
- a directory,
- another repository,
- the CLI,
- CI,
- an agent,
- or a team.

### Job 5: Make a repository comply with image policies

> “Find image assets that violate our project rules and fix them.”

The product should eventually understand project-level conventions and provide lint/fix behavior analogous to developer tools such as formatters and linters.

### Job 6: Let coding agents manipulate images through a reliable primitive

Instead of having every coding agent invent an ImageMagick or Sharp workflow, the product should expose stable operations through CLI/API/MCP interfaces.

The agent should call the same engine the GUI uses.

---

## 5. Product Thesis

The product should not begin as a general-purpose image editor with AI added to it.

It should begin as a **developer-focused image workbench**.

The core interaction loop is:

1. open an image, folder, or repository,
2. describe the desired outcome or select a known operation,
3. receive a structured transformation plan,
4. preview the result visually,
5. adjust it through natural language or direct controls,
6. apply the transformation,
7. optionally save the operations as a reusable recipe,
8. reproduce the exact behavior from GUI, CLI, API, CI, or an agent.

A representative interaction:

> “Make these appropriate for responsive website images. Maximum source width 2400 px, WebP where possible, preserve transparency, strip metadata, and keep each below 400 KB.”

The product might respond with:

- 132 files analyzed,
- 117 JPEG/PNG photographs recommended for WebP conversion,
- 8 images require resizing,
- 15 transparent PNGs should remain PNG,
- 7 files already comply,
- estimated total size reduction: 68%.

The user can visually inspect representative or exceptional outputs before clicking **Apply**.

This combines the strongest properties of:

- GUI editors: visual confidence,
- CLI tools: deterministic power,
- scripts: repeatability,
- LLMs: intent-based interaction,
- and CI: enforceable standards.

---

## 6. Product Principles

### 6.1 Deterministic first, generative when necessary

If a crop, resize, colorspace conversion, encoder, or metadata operation can solve the problem, use it.

Generative models should be reserved for tasks such as:

- outpainting,
- object removal,
- semantic reframing,
- background generation,
- segmentation,
- or operations where image understanding is required.

### 6.2 The user should always be able to understand what happened

Natural-language requests should compile into visible structured operations.

Example:

```yaml
operations:
  - auto-orient
  - smart-crop:
      aspect: 16:9
      focus: primary-subject
  - resize:
      width: 1920
      upscale: false
  - colorspace: srgb
  - encode:
      format: webp
      maxBytes: 300kb
  - strip-metadata
```

The application should not merely report “Done.”

### 6.3 GUI, CLI, recipe, and agent should describe the same operation model

There should be one conceptual image API underneath the product.

A transformation performed visually should be reproducible through code or CLI.

A transformation requested by an LLM should be editable visually.

A recipe should be executable in CI without a GUI.

### 6.4 Local-first should be the default

Routine image processing should happen locally.

Users should not need to upload ordinary project assets to a vendor cloud simply to resize, compress, convert, or inspect them.

Cloud services should be used only where they provide meaningful additional value, such as hosted AI inference, synchronization, collaboration, or remote automation.

### 6.5 AI providers should be interchangeable

The product should avoid depending strategically on a single foundation model or image-generation provider.

Potential backends may include:

- hosted LLM providers,
- hosted image generation/editing providers,
- local LLMs,
- local diffusion/image systems,
- and future model providers.

Better foundation models should improve the product rather than threaten it.

### 6.6 Developer ergonomics should outrank creative-suite completeness

The product should optimize for:

- speed,
- keyboard use,
- predictable file behavior,
- Git friendliness,
- transparency,
- batch work,
- scripting,
- discoverability,
- and reproducibility.

It should not initially optimize for matching every Photoshop feature.

---

## 7. Leading MVP Wedge

The strongest current MVP hypothesis is:

> **Natural-language and direct image transformation with live visual preview, batch execution, and reusable recipes.**

A possible v0.1 workflow:

1. User opens a file or directory.
2. The app displays assets in a fast visual browser.
3. User types:
   > “Resize these for the website. Maximum width 2000 px, don’t upscale, WebP, under 350 KB.”
4. The system generates a structured plan.
5. The app shows before/after previews, resulting dimensions, output formats, and estimated file sizes.
6. The user can adjust individual exceptions.
7. User applies the plan.
8. User can save the transformation as a recipe.
9. The same recipe can be invoked from the CLI.

### Candidate “magic” workflow

The highest-value demo may be:

> Open a repository → ask the product to find and optimize problematic images → visually review the proposed changes → apply them → save/enforce the policy.

This demonstrates the full differentiator:

- project context,
- natural language,
- deterministic transformation,
- visual feedback,
- batch processing,
- repeatability,
- and developer workflow.

This is still a hypothesis and should be challenged during validation.

---

## 8. Deliberate Non-Goals for the Initial Product

The first product should not attempt to provide:

- Photoshop feature parity,
- professional painting tools,
- advanced brush engines,
- comprehensive RAW-development workflows,
- exhaustive channel/path tooling,
- print/prepress workflows,
- professional CMYK production,
- complex typography/layout design,
- video editing,
- Canva-style document design,
- or proprietary cloud asset hosting as a prerequisite for basic usage.

Every one of these expands the product into a much more mature and crowded category.

The initial question is not:

> “Can this replace Photoshop?”

It is:

> “Can this become the fastest, most trustworthy way for a developer to get image work done?”

---

## 9. Technical Hypothesis

Technical choices remain provisional, but the current architecture hypothesis is:

### Core raster engine

**libvips** as the primary deterministic image-processing engine.

Reasons:

- optimized for high-performance image processing,
- well suited to batch workflows,
- efficient with large images,
- mature format/codec ecosystem,
- strong precedent in developer tooling through Sharp,
- and less baggage than using a full creative application as the engine.

ImageMagick may serve as an optional compatibility or specialty backend where useful.

GEGL may become relevant later if the product evolves toward sophisticated non-destructive editing graphs, adjustment layers, or deeper Photoshop-like behavior.

The product should not initially fork GIMP.

### Operation model

The most strategically important technical layer is a product-owned structured operation schema.

Conceptually:

```text
User intent
    ↓
Planner
    ↓
Operation specification
    ↓
Execution engine
    ↓
Visual result
```

The operation schema should be:

- deterministic where possible,
- serializable,
- versionable,
- human-readable,
- executable without an LLM,
- compatible with batch processing,
- usable by GUI and CLI,
- and suitable for agent tool calls.

### Desktop architecture

A fast initial implementation may use a web-technology UI with a desktop shell and native image-processing bindings.

Possible early stack:

- TypeScript,
- React/Vue/Svelte,
- Electron for rapid prototyping,
- Sharp/libvips for initial raster execution.

A later move toward Tauri/Rust or another native shell is possible if performance, packaging, or distribution makes it worthwhile.

The early architecture should avoid making such a migration unnecessarily difficult.

---

## 10. The Recipe and Policy Hypothesis

A key potential source of defensibility is a declarative format for image intent.

Example:

```yaml
# .imgdev.yml

defaults:
  colorspace: srgb
  stripMetadata: true
  upscale: false

rules:
  public/images/**:
    maxWidth: 2400
    maxBytes: 400kb
    preferredFormat: webp

  public/heroes/**:
    aspectRatio: 16:9
    minWidth: 1920
```

This could eventually support:

```bash
imgdev check
imgdev fix
imgdev review
```

The recipe/policy format could connect:

- visual editing,
- bulk transforms,
- project conventions,
- CI,
- code review,
- agents,
- IDE integrations,
- and team presets.

A widely adopted recipe/config format could provide significantly more ecosystem defensibility than the AI chat experience itself.

This is currently a **moat hypothesis**, not validated fact.

---

## 11. Competitive Landscape

The product sits between several established categories.

### Creative suites: Photoshop, GIMP, Krita

Strengths:

- rich manual editing,
- visual precision,
- mature creative workflows.

Weakness relative to this thesis:

- too broad for many developer tasks,
- manual workflows can be difficult to reproduce,
- project/repository conventions are not the primary mental model,
- automation and developer workflows are secondary.

The product should avoid competing directly on creative depth.

### CLI/libraries: ImageMagick, libvips, Sharp

Strengths:

- powerful,
- fast,
- deterministic,
- automatable,
- mature.

Weakness relative to this thesis:

- poor visual feedback,
- syntax/API learning cost,
- users must construct workflows themselves,
- little opinionated project-level UX.

These are more likely to be underlying technologies or complementary tools than enemies.

### Cloud media platforms: Cloudinary and similar services

Strengths:

- mature transformation APIs,
- media pipelines,
- optimization,
- delivery infrastructure,
- increasingly strong AI/agent integrations.

Weakness relative to this thesis:

- cloud/infrastructure-oriented,
- may require assets to become part of a hosted media system,
- broader platform commitment than a local developer utility,
- not primarily a local visual workbench for files already in a repository.

Cloud media platforms may be the most strategically relevant adjacent competitor.

### General-purpose AI: ChatGPT, Claude, Gemini, Codex, coding agents

Strengths:

- natural-language interface,
- increasingly capable vision,
- tool use,
- ability to improvise scripts and workflows.

Weakness relative to this thesis:

- lack of a dedicated deterministic image operation model,
- inconsistent tooling between sessions/environments,
- weaker purpose-built visual review,
- ad-hoc scripts rather than standardized reusable image policies.

These products should ideally become **clients of the product**, not only competitors.

### Browser/design tools: Canva, Photopea, others

Strengths:

- low-friction access,
- visual editing,
- increasingly capable AI.

Weakness relative to this thesis:

- aimed primarily at visual creation/design rather than repository-level developer workflows,
- weaker CLI/CI/project-policy identity.

---

## 12. Monetization Hypothesis

The product should consider a free/open core with paid services rather than charging rent for basic image editing.

Working principle:

> **Do not charge for the paintbrush. Charge when computers do meaningful work for the user.**

Possible structure:

### Community / Free

- local image editor/workbench,
- deterministic transformations,
- batch processing,
- recipes,
- CLI,
- local execution,
- local model integration,
- bring-your-own API keys.

### Pro

Paid subscription could include:

- hosted AI usage,
- managed model routing,
- semantic segmentation,
- generative fill/expand,
- cloud recipe/preset synchronization,
- project history,
- enhanced agent workflows,
- remote jobs.

### Teams

Could add:

- shared policies,
- shared recipes,
- approvals,
- role/permission controls,
- centralized AI usage,
- audit/history,
- asset standards.

### API / automation

Usage-based or higher-tier plans may support:

- remote batch jobs,
- hosted automation,
- API access,
- CI infrastructure,
- agency-scale processing.

Hosted AI costs should likely be metered rather than hidden inside an unlimited low-cost subscription.

Bring-your-own-provider support may be strategically valuable for developer trust.

All pricing and packaging remain unvalidated.

---

## 13. Moat Hypothesis

### 13.1 What is not a moat

The following should be assumed easy to reproduce:

- a chat box,
- LLM-to-libvips translation,
- generic AI image editing,
- natural-language resizing/cropping,
- basic GUI wrappers around image libraries.

If the product consists primarily of those features, it is vulnerable to commoditization.

### 13.2 Potential defensibility

The stronger moat hypothesis combines:

1. **A coherent operation and recipe model**  
   One representation spanning GUI, CLI, API, CI, and AI.

2. **Repository awareness**  
   Understanding how assets are actually used in software projects.

3. **Project image policies**  
   A standard way to describe and enforce image requirements.

4. **Visual review of deterministic automation**  
   Making automated image changes trustworthy.

5. **Developer ecosystem integration**  
   Git, CI, IDEs, package managers, MCP, agents, build systems.

6. **Plugins and extensibility**  
   Allowing the community to add operations, codecs, rules, and integrations.

7. **Local-first trust**  
   Images remain local unless a task specifically requires remote inference or cloud services.

8. **Community and standard adoption**  
   Recipes/configuration becoming familiar enough that developers expect tools and agents to understand them.

### 13.3 Strategic goal

The long-term goal should be:

> When an AI coding agent needs to manipulate project images reliably, it chooses this tool rather than improvising a new script.

That is a stronger strategic position than attempting to own the foundation model.

---

## 14. Major Risks

### Risk 1: Coding agents make the dedicated product unnecessary

A future coding agent may be able to:

- inspect the repository,
- install or invoke Sharp/ImageMagick,
- write a script,
- process the images,
- visually evaluate outputs,
- correct mistakes,
- and clean up afterward.

If this becomes sufficiently fast and reliable, a standalone developer image tool may feel redundant.

**Required response:** the product must provide a substantially better primitive: faster execution, safer operations, immediate visual feedback, persistent policies, history, recipes, and standardized integration.

### Risk 2: The pain is real but too infrequent

Developers may dislike image editing but encounter the problem too rarely to install or pay for a dedicated product.

**Required validation:** measure frequency and identify high-frequency user segments such as agencies, CMS developers, ecommerce developers, and content-heavy application teams.

### Risk 3: Developers will use the CLI but not the GUI

The visual application may be less valuable than expected if developers prefer simply asking coding agents to execute operations.

**Required validation:** determine where visual inspection materially changes confidence or speed.

### Risk 4: “Open-source Photoshop” scope creep

Feature requests may quickly drag the product toward:

- advanced brushes,
- RAW support,
- complex layers,
- typography,
- designer workflows,
- and general creative-suite parity.

**Required response:** maintain a clear initial definition of developer image jobs and deliberately reject features that do not strengthen them.

### Risk 5: Incumbents converge on the same workflow

Adobe, Canva, Cloudinary, AI providers, or new developer tools could implement increasingly similar natural-language and automation features.

**Required response:** build around workflow, standards, interoperability, local-first execution, developer trust, and ecosystem adoption rather than proprietary access to AI.

### Risk 6: Recipe/config standard fails to gain adoption

The recipe language could become internal complexity nobody outside the app cares about.

**Required validation:** recipes must solve immediate user problems even if the broader ecosystem never adopts the format.

### Risk 7: AI unpredictability undermines trust

Users may distrust automated semantic crops, object detection, compression decisions, or generative edits.

**Required response:** make plans inspectable, provide previews, distinguish deterministic from generative operations, and make every change reversible.

---

## 15. Open Questions and Unproven Assumptions

These should be treated as explicit targets for adversarial review and validation.

### User/problem questions

- How frequently do developers actually manipulate images manually?
- Which developer segments experience this pain weekly rather than monthly?
- Is image optimization the most common pain, or merely the most obvious one?
- Do users want a visual application, or would a CLI + browser preview be enough?
- Does “Photoshop for developers” resonate, or does it imply too much creative-suite complexity?
- Is “image toolchain for developers” clearer or too abstract?

### Workflow questions

- What is the single best first workflow?
- Is opening a repository more compelling than opening an image?
- Should the product begin as a directory/image workbench and add repo intelligence later?
- How much manual editing is necessary for the product to feel complete?
- Is a live image preview enough, or is a small canvas/editor necessary from day one?
- How should exceptional files in a batch transformation be surfaced?

### AI questions

- Which tasks actually need an LLM?
- Which tasks require vision?
- Which tasks require generative image models?
- Can semantic operations such as smart cropping run locally at acceptable quality?
- Does BYO model/provider support create trust or unnecessary complexity?

### Technical questions

- Is libvips sufficient for all v0.1 operations?
- Is Sharp an acceptable prototype layer or should the product bind more directly to libvips?
- Electron vs. Tauri vs. another desktop architecture?
- How should recipes handle coordinates and transformations that depend on image dimensions?
- How should operation schemas evolve without breaking stored recipes?
- How should deterministic and generative steps coexist in a reproducible pipeline?

### Business questions

- Will developers pay for hosted AI when BYO keys/local models are allowed?
- Is cloud sync valuable enough to support recurring revenue?
- Are agencies/teams a better paying customer than individual developers?
- Could CI/API automation become a larger business than the desktop product?
- Should the core be fully open source, open-core, source-available, or proprietary with open tooling?
- Does open source materially improve distribution and trust?

### Competitive questions

- Are there existing developer-image products that already combine visual review, local processing, recipes, CLI, and AI?
- How quickly could Cloudinary move down-market/local?
- How quickly could general coding agents make the visual workflow unnecessary?
- Could IDE vendors absorb this feature category?
- Is repository-aware image optimization a standalone category or ultimately just a feature?

---

## 16. Validation Plan Before a PRD

A traditional PRD should **not** be the next step immediately after this thesis.

First, the thesis should be deliberately attacked.

### Phase A: Adversarial review

Provide this document to fresh LLM sessions with intentionally hostile roles.

Suggested reviews:

1. **Skeptical developer**
   - Explain why you would never install this.
   - Identify workflows that are already easier with existing tools.

2. **Coding-agent maximalist**
   - Argue that Claude/Codex + ImageMagick/Sharp makes this product obsolete before launch.

3. **Cloudinary product strategist**
   - Explain how an incumbent could neutralize this differentiation.

4. **Adobe/Canva strategist**
   - Identify which features are merely inevitable additions to existing creative products.

5. **Skeptical investor**
   - Attack market size, frequency of use, monetization, defensibility, and distribution.

6. **Open-source maintainer**
   - Challenge the technical complexity, licensing strategy, community expectations, and maintenance burden.

7. **UX reviewer**
   - Challenge whether combining GUI, CLI, AI, recipes, and repo context creates a coherent product or an overloaded one.

The objective is not to ask these reviewers to improve the idea initially. The first objective is to identify reasons **not to build it**.

### Phase B: Synthesis

Create:

`02-adversarial-review.md`

This should contain:

- strongest objections,
- evidence supporting each,
- rebuttal if one exists,
- whether the objection changes the thesis,
- assumptions requiring human validation,
- and product changes resulting from review.

### Phase C: Jobs and MVP boundary

If the thesis survives, create:

`03-jobs-and-mvp.md`

That document should identify:

- primary user,
- top recurring jobs,
- one flagship workflow,
- explicit MVP features,
- explicit non-goals,
- and usability success criteria.

Only after this should implementation architecture and a PRD become authoritative.

---

## 17. Proposed Documentation Sequence

```text
/docs
├── 01-product-thesis.md
├── 02-adversarial-review.md
├── 03-jobs-and-mvp.md
├── 04-architecture.md
├── 05-prd-v0.1.md
└── 06-implementation-plan.md
```

### 01 — Product Thesis

Why this product should exist.

### 02 — Adversarial Review

Why it may fail and how the thesis changed after critique.

### 03 — Jobs and MVP

Exactly whose problems the first version solves.

### 04 — Architecture

Technical decisions, operation schema, execution model, licensing, providers, and interfaces.

### 05 — PRD v0.1

Behavior, flows, acceptance criteria, edge cases, performance requirements, and non-goals.

### 06 — Implementation Plan

Coding-agent-oriented milestones, task order, test strategy, repository structure, interfaces, and definition of done.

---

## 18. Current Working Positioning

### Category

**Developer image tooling**

### Primary positioning

> **The image toolchain for developers.**

### Supporting description

A local-first image workbench that combines visual feedback, deterministic transformations, natural language, reusable recipes, batch processing, CLI/CI automation, and agent integration.

### Useful shorthand

> **Image editing for people who would rather be coding.**

### Alternative explanatory shorthand

> **The missing visual layer between ImageMagick and an AI coding agent.**

These are working positioning statements, not final brand copy.

---

## 19. Current Strategic Convictions

The following ideas currently appear strong enough to guide further exploration, while still remaining revisable:

1. **Do not compete directly with Photoshop on creative depth.**
2. **Developers are the initial wedge, not designers.**
3. **The operation/recipe model matters more strategically than the LLM provider.**
4. **Use deterministic image processing whenever possible.**
5. **Visual feedback is the important missing layer in CLI/agent workflows.**
6. **Batch and repository workflows are likely more valuable than one-image-at-a-time editing.**
7. **Local-first execution is both technically and strategically attractive.**
8. **GUI, CLI, CI, and agent interfaces should converge on one underlying operation model.**
9. **The AI layer should be replaceable.**
10. **The product must remain useful even if AI models improve dramatically.**
11. **The largest threat is not Adobe; it is general coding agents becoming “good enough” at ad-hoc image work.**
12. **The long-term opportunity may be larger as developer infrastructure/automation than as a desktop editor alone.**

---

## 20. The Core Test

Before this idea advances to a PRD, we should be able to answer:

> **Why does a developer install this instead of simply asking their coding agent to use ImageMagick or Sharp?**

A strong answer might eventually be:

> Because this tool gives the developer and the agent a shared, purpose-built image environment: immediate visual inspection, deterministic operations, reusable project policies, batch review, undo/history, Git-aware workflows, and a standard interface that works locally, interactively, and in CI.

If testing shows that this answer is not compelling enough in actual usage, the product thesis should change or be abandoned.

---

## 21. Instructions for the Next Reviewer

Treat this document as a **hypothesis, not a pitch deck**.

Do not assume:

- the proposed market is large,
- the described pain is frequent,
- users will pay,
- the proposed moat is real,
- the technical architecture is correct,
- the recipe format will gain adoption,
- or the GUI is necessary.

Prefer evidence and concrete competing workflows over abstract criticism.

The most useful review will identify:

1. existing products or workflows that make this unnecessary,
2. assumptions that are likely false,
3. reasons the target user will not adopt it,
4. scope that should be removed,
5. a stronger initial wedge if one exists,
6. technical choices that would create unnecessary complexity,
7. monetization weaknesses,
8. and conditions under which the idea should **not** be built.

The goal is not to preserve this thesis.

The goal is to discover whether there is a durable product hidden inside it.
