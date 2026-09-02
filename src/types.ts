/**
 * Rasterwright's core data model.
 *
 * The pipeline is:
 *
 *   policy -> analysis -> operation plan -> execution -> verification
 *
 * This session implements up to and including analysis/policy evaluation.
 * `operations/` (plan + execution + verification) does not exist yet, on purpose.
 *
 * Everything here is plain data. `policy/` is pure functions over it, which is
 * what makes `check` provably read-only.
 */

/** Formats Rasterwright understands. Anything else is `unknown` and skipped. */
export type ImageFormat = 'jpeg' | 'png' | 'webp';

/** What we could determine about an image's colour space. */
export type ColorSpaceStatus =
  /** Confidently sRGB (or an untagged RGB/greyscale image, which is sRGB by convention). */
  | 'srgb'
  /** Confidently not sRGB (CMYK pixels, or an ICC profile that names another space). */
  | 'non-srgb'
  /** An ICC profile is present but Rasterwright could not identify it. Never reported as a violation. */
  | 'unknown';

/**
 * What we learned by looking at a file. Never mutated.
 *
 * `width`/`height` are the *displayed* dimensions, i.e. after the EXIF
 * orientation flag is applied. That is what a browser renders and therefore
 * what `maxWidth` should govern. `storedWidth`/`storedHeight` are the raw
 * encoded dimensions and differ only for orientation values 5-8.
 */
export interface ImageInfo {
  /** Repo-relative, POSIX separators, on every platform. */
  path: string;
  bytes: number;
  format: ImageFormat;
  width: number;
  height: number;
  storedWidth: number;
  storedHeight: number;
  /** An alpha channel exists. Says nothing about whether it is used. */
  hasAlpha: boolean;
  /**
   * Every pixel is fully opaque (from sharp's `stats()`).
   * Only computed when `hasAlpha` is true; `null` means "not determined",
   * which callers must treat as "assume transparent".
   */
  isOpaque: boolean | null;
  /**
   * Bits per channel: 8 for every ordinary web image.
   *
   * A 16-bit source matters because Sharp's encoders write 8 bits per channel,
   * so any rewrite of one silently halves its precision. v0 refuses to rewrite
   * those rather than quietly degrade them.
   */
  bitDepth: number;
  /** libvips' interpretation of the pixel data: 'srgb', 'cmyk', 'b-w', ... */
  pixelColorSpace: string;
  colorSpaceStatus: ColorSpaceStatus;
  hasIccProfile: boolean;
  /** Best-effort ICC profile description; `null` when none could be parsed out. */
  iccDescription: string | null;
  hasExif: boolean;
  hasXmp: boolean;
  hasIptc: boolean;
  /** Photoshop TIFF tag, or PNG text chunks: ancillary, but neither EXIF nor XMP. */
  hasOtherMetadata: boolean;
  /** EXIF orientation; 1 is normal. Absent orientation is reported as 1. */
  orientation: number;
  isAnimated: boolean;
  /** sha256 of the file's bytes, hex. */
  contentHash: string;
}

/** Quality band for the future encoder. See `RuleBody.quality`. */
export interface QualityBand {
  /**
   * The MAXIMUM quality Rasterwright will initially encode at, not a target.
   * If the output at this quality already satisfies `maxBytes`, it is accepted.
   * Quality is only ever searched *downward* from here.
   */
  start: number;
  /** The lowest quality Rasterwright may fall to before failing explicitly. */
  floor: number;
}

/** A set of policy properties. `defaults` is one of these; so is every rule's body. */
export interface RuleBody {
  maxWidth?: number;
  maxHeight?: number;
  /**
   * A CEILING, not a target. Normalized to whole bytes at config load time.
   * Rasterwright never grows a file to consume unused budget.
   */
  maxBytes?: number;
  /** Preferred output format. A different current format is a `format` violation. */
  format?: ImageFormat;
  /** Never enlarge an image. Always false in v0; present so the schema is stable. */
  upscale?: boolean;
  /**
   * A normalization *preference*, not an enforcement rule: if Rasterwright ever
   * rewrites this file, ancillary metadata should be dropped. Default true.
   * Findings it produces are warnings, never errors. ICC profiles are excluded -
   * those are colour management, handled by `colorSpace`.
   */
  stripMetadata?: boolean;
  /**
   * Normalize a non-normal EXIF orientation flag. Default true. When false,
   * Rasterwright leaves orientation alone and reports nothing about it.
   */
  autoOrient?: boolean;
  /** Only 'srgb' is meaningful in v0. */
  colorSpace?: 'srgb';
  quality?: QualityBand;
}

export interface Rule {
  /** The glob exactly as written in the config file. */
  glob: string;
  body: RuleBody;
}

/** The whole config file, normalized. */
export interface Policy {
  version: 1;
  defaults: RuleBody;
  /** Ordered as written in the file. Order is significant; see `config/resolve.ts`. */
  rules: Rule[];
}

/** The result of merging `defaults` with every matching rule, in file order. */
export interface EffectiveRule {
  body: RuleBody;
  /** Globs that matched, in file order. Empty means the file is ungoverned. */
  matchedGlobs: string[];
  /**
   * Which glob supplied each property's winning value, so a violation can name
   * the rule the user actually wrote. `'(defaults)'` for the defaults block.
   */
  sources: Partial<Record<keyof RuleBody, string>>;
}

/**
 * Every check Rasterwright can report on.
 *
 * The first group are policy constraints the repository contract says are
 * genuinely wrong. The rest are normalization preferences and observations.
 */
export type CheckName =
  | 'maxWidth'
  | 'maxHeight'
  | 'maxBytes'
  | 'format'
  | 'extension'
  | 'colorSpace'
  | 'orientation'
  | 'decode'
  | 'metadata'
  | 'colorSpaceUnknown'
  | 'animated'
  | 'ruleGlobExcludesTargetFormat';

/*
 * Transparency is deliberately absent from this list.
 *
 * `hasAlpha` and `isOpaque` are ordinary properties of PNG and WebP files, not
 * events: emitting a finding for each one produced 55 notes on the first real
 * project, almost all of them saying "this PNG has an alpha channel". They stay
 * on `ImageInfo` - available in `--json` and to future fix planning - and are
 * reported only where they change an answer, which today is a `format: jpeg`
 * rule against an image with real alpha. That surfaces as the `format` finding
 * being unfixable, with transparency named as the reason.
 */

/**
 * How much a finding should matter.
 *
 * - `error`   - the repository contract is broken. Fails the run (exit 1).
 * - `warning` - worth fixing, does not make the repo wrong. Never fails the run.
 * - `info`    - an observation that explains what a future `fix` would do.
 *
 * The split exists because the first real run against a production theme found
 * three genuine constraint violations and seventeen files carrying harmless
 * EXIF. Treating those the same made the useful findings unreadable.
 */
export type Severity = 'error' | 'warning' | 'info';

/**
 * Whether a future `fix` could resolve a finding.
 *
 * - `yes`     - a deterministic transform resolves it.
 * - `no`      - it cannot be resolved safely (e.g. JPEG cannot hold transparency).
 * - `unknown` - nothing blocks it, but the answer depends on encoding results
 *               that `check` deliberately does not produce. `maxBytes` is the
 *               only check that lands here.
 * - `n/a`     - there is nothing to fix (informational findings).
 */
export type Fixability = 'yes' | 'no' | 'unknown' | 'n/a';

/** One thing Rasterwright noticed about one file. */
export interface Finding {
  path: string;
  /** The glob whose value produced it, or '(defaults)' / '(built-in)'. */
  rule: string;
  check: CheckName;
  severity: Severity;
  /** What the file actually is. `null` for findings with no measurement. */
  actual: string | number | null;
  /** What policy allows. `null` for findings with no measurement. */
  allowed: string | number | null;
  fixable: Fixability;
  /** Why it is not fixable, or what a fix would have to do. */
  message: string;
}

/** Highest severity present on a file; `clean` when it has no findings. */
export type FileStatus = 'clean' | 'info' | 'warning' | 'error';

export interface FileResult {
  path: string;
  status: FileStatus;
  /** Undefined only when the file could not be decoded. */
  image?: ImageInfo;
  /** The merged policy that applied. Undefined when the file could not be decoded. */
  policy?: RuleBody;
  matchedGlobs: string[];
  findings: Finding[];
  /**
   * Aggregate fixability across this file's error- and warning-level findings.
   * 'yes' when there is nothing to fix.
   */
  fixable: Fixability;
  /** The decoder's message, when the file could not be read or decoded. */
  error?: string;
}

export interface CheckSummary {
  /** Governed images that were inspected. */
  checked: number;
  /** No errors and no warnings. Files carrying only info findings count as clean. */
  clean: number;
  /** At least one warning. Counted independently of `withErrors`; a file can be in both. */
  withWarnings: number;
  /** At least one error. */
  withErrors: number;
  /** Total findings by severity, across every file. */
  errors: number;
  warnings: number;
  infos: number;
  /** Files that could not be decoded. A subset of `withErrors`. */
  unreadable: number;
  /** Image files found but matched by no rule. Silently skipped. */
  ignored: number;
}

export interface CheckReport {
  rasterwrightVersion: string;
  /** True when no file produced an error-level finding. Warnings do not affect it. */
  clean: boolean;
  /** Absolute path to the config that was used. */
  configPath: string;
  /** Absolute path to the project root (the directory holding the config). */
  root: string;
  summary: CheckSummary;
  files: FileResult[];
}

/*
 * ---------------------------------------------------------------------------
 * Fix planning
 *
 * `check` answers "what is wrong with this file". Planning answers "what would
 * Rasterwright do about it", and nothing more: producing a plan writes nothing,
 * encodes nothing, and reads nothing beyond the `FileResult` it is handed.
 *
 * Execution (`operations/execute.ts`) does not exist yet. Until it does, a plan
 * is the whole product of `rasterwright fix --dry-run`.
 * ---------------------------------------------------------------------------
 */

/**
 * Permissions granted to a single fix run.
 *
 * These live on the *command*, never in `.rasterwright.yml`. Policy describes
 * the state the assets should be in; a permission says what this invocation is
 * allowed to do on the way there. Do not add an `allowRenames` config property.
 */
export interface FixPermissions {
  /**
   * `--allow-renames`. Required before any operation that changes a filename:
   * a format conversion (`hero.jpg` -> `hero.webp`) and correcting a misleading
   * extension (`logo.png` holding WebP bytes) both qualify. Either can break a
   * reference in source code, which is the only thing that matters here.
   */
  allowRenames: boolean;
}

/** A permission a plan needs but was not given. */
export type FixPermissionName = 'allowRenames';

export interface Dimensions {
  width: number;
  height: number;
}

/**
 * One deterministic step. Operations are produced in execution order:
 *
 *   1. autoOrient   - changes the dimensions everything downstream depends on
 *   2. resize       - down only; encoding a smaller image is the primary lever
 *   3. toColorSpace - after geometry, before encoding
 *   4. encode       - exactly one per file. Metadata handling happens here.
 *   5. rename       - last, so nothing has to be reopened under a new name
 *
 * A file is rewritten at most once per run. A compliant file is never
 * rewritten at all.
 */
export type PlannedOperation =
  | AutoOrientOperation
  | ResizeOperation
  | ColorSpaceOperation
  | EncodeOperation
  | RenameOperation;

/** Apply the EXIF orientation flag to the pixels, then clear it. */
export interface AutoOrientOperation {
  op: 'autoOrient';
  /** The flag being applied. Never 1. */
  orientation: number;
  /** Stored dimensions, which are what the encoded pixels currently are. */
  from: Dimensions;
  /** Displayed dimensions, which is what the stored pixels become. */
  to: Dimensions;
}

/**
 * Downscale to fit inside the policy limits.
 *
 * `to` is computed by rounding *down*, so the result can never land a pixel
 * over a limit and leave `fix` with work to do on its next run.
 */
export interface ResizeOperation {
  op: 'resize';
  from: Dimensions;
  to: Dimensions;
  /** The limits that produced `to`. Present only when the policy sets them. */
  maxWidth?: number;
  maxHeight?: number;
  fit: 'inside';
  /** Always false. Rasterwright never enlarges an image. */
  upscale: false;
}

/** Convert the pixels to sRGB. Only planned for a confident non-sRGB error. */
export interface ColorSpaceOperation {
  op: 'toColorSpace';
  space: 'srgb';
  /** What the image is now, as the ICC profile or libvips describes it. */
  from: string;
}

/**
 * Write the pixels out. Exactly one per rewritten file.
 *
 * Metadata stripping is an encoder setting rather than a separate pass, because
 * that is what it is: Sharp drops ancillary metadata by default and opts back
 * in per kind. Representing it as its own operation would suggest a second
 * rewrite that never happens.
 */
export interface EncodeOperation {
  op: 'encode';
  format: ImageFormat;
  /** The ceiling the output must satisfy, when the policy sets one. */
  maxBytes?: number;
  /**
   * True when an over-budget file is the *reason* for this encode, as opposed
   * to a ceiling that merely also applies to a rewrite something else required.
   */
  budgetDriven: boolean;
  /** Quality band for a lossy target. Absent for PNG, which has no quality dial. */
  quality?: QualityBand;
  /**
   * Drop ancillary, non-colour metadata - EXIF, XMP, IPTC, Photoshop tags,
   * text chunks - as part of this rewrite. ICC profiles are never included:
   * they are colour management, and stripping one changes how every pixel is
   * interpreted. Under `colorSpace: srgb` the output is explicitly tagged sRGB.
   */
  stripMetadata: boolean;
  /** The source carries transparency that the output must keep. */
  preserveAlpha: boolean;
  /**
   * Already-lossy pixels are being re-compressed, so generation loss is real.
   * Allowed only because an error-level finding demanded the rewrite; it is
   * surfaced rather than presented as a free saving.
   */
  lossyReencode: boolean;
  /**
   * Planning has not encoded anything, so the resulting size is not known here.
   * When true, execution must measure the output and fail if it does not fit.
   */
  outcomeRequiresVerification: boolean;
  /**
   * Carry the source's EXIF orientation flag through to the output instead of
   * letting the encoder drop it.
   *
   * Only ever true under `autoOrient: false` on a file whose flag is not 1, when
   * some *other* error forced a rewrite. Sharp strips metadata by default, so a
   * plain re-encode of such a file would silently clear the flag while leaving
   * the pixels unrotated, and the image would display rotated. Preserving the
   * flag keeps the displayed image identical, at the cost of a minimal EXIF
   * block in the output: a later `check` reports that as a metadata warning,
   * which is expected and never a reason to rewrite the file again.
   */
  preservesOrientation: boolean;
}

/**
 * Change the filename. Requires `--allow-renames`.
 *
 * `reencode: false` is the case worth having a name for: `logo.png` whose bytes
 * are already WebP needs its extension corrected and nothing else. Decoding and
 * re-encoding those pixels to fix a filename would be pure loss.
 */
export interface RenameOperation {
  op: 'rename';
  from: string;
  to: string;
  reason: 'format-conversion' | 'extension-correction';
  /** Whether pixel operations precede this rename. */
  reencode: boolean;
}

/**
 * What a fix run would do to one file.
 *
 * - `unchanged`           - nothing to do. No error-level findings.
 * - `planned`             - a complete plan exists and this run may execute it.
 * - `requires-permission` - a plan exists but the run lacks permission for it.
 * - `blocked`             - the plan is complete and permitted, but its output
 *                           path collides with another plan or with a file that
 *                           already exists. Only batch preflight can see this;
 *                           `planFile()` is file-local by design.
 * - `unfixable`           - no safe transform resolves it (or it cannot be read).
 * - `unsupported`         - v0 does not transform this kind of image at all.
 */
export type FixPlanStatus =
  | 'unchanged'
  | 'planned'
  | 'requires-permission'
  | 'blocked'
  | 'unfixable'
  | 'unsupported';

export interface FilePlan {
  path: string;
  /** Where the file would end up. Differs from `path` only for a rename. */
  targetPath: string;
  status: FixPlanStatus;
  /**
   * Operations this run would execute, in order. Empty unless `planned`:
   * a file whose plan is blocked gets no operations at all, because a plan is
   * applied coherently or not applied.
   */
  operations: PlannedOperation[];
  /**
   * The plan that permission would unlock, for `requires-permission`, or the
   * plan a path collision refused, for `blocked`. Reported so the user can see
   * what they are being asked to authorize or resolve. Never executed.
   */
  blockedOperations: PlannedOperation[];
  /** Error-level checks the plan would resolve. */
  resolves: CheckName[];
  /** Error-level checks that would still be outstanding afterwards. */
  unresolved: CheckName[];
  /**
   * Warning-level checks that get normalized for free during a rewrite some
   * error already required. Never a reason to rewrite a file on their own.
   */
  normalizedDuringRewrite: CheckName[];
  /** Warning-level checks present on the file, resolved or not. */
  warnings: CheckName[];
  /** True when the outcome depends on encoding results planning cannot know. */
  requiresVerification: boolean;
  /** Permissions the plan needs and does not have. */
  requiredPermissions: FixPermissionName[];
  /** Why the file is blocked, unfixable or unsupported. Plain language. */
  reasons: string[];
  /** Honest caveats about a plan that is otherwise complete. */
  notes: string[];
}

/**
 * Why batch preflight refused a plan. See `operations/plan-set.ts`.
 *
 * - `duplicate-target`  - two or more plans in this run claim one output path.
 * - `target-exists`     - a rename would land on a path that already exists.
 * - `source-claimed`    - another plan's rename would land on *this* plan's
 *                         current path. Sequencing the two would work, and
 *                         Rasterwright refuses to sequence renames.
 * - `target-unreadable` - the target path could not be probed at all, so
 *                         whether it is free is unknown.
 */
export type ConflictKind =
  | 'duplicate-target'
  | 'target-exists'
  | 'source-claimed'
  | 'target-unreadable';

export interface PlanSetConflict {
  /** The plan that is blocked, by its current path. */
  path: string;
  /**
   * The path that collided. Usually the plan's output path; for
   * `source-claimed` it is the plan's own current path, which is what another
   * plan is trying to write.
   */
  targetPath: string;
  kind: ConflictKind;
  /** The paths collide only once folded for a case-insensitive filesystem. */
  caseOnly: boolean;
  /** The other paths involved: competing plans, or the occupying file. */
  with: string[];
  /** A sentence naming what collided, suitable for a report. */
  message: string;
}

export interface FixPlanSummary {
  /** Governed images that were inspected. */
  checked: number;
  planned: number;
  requiresPermission: number;
  /** Plans refused by batch preflight because their output path collides. */
  blocked: number;
  unfixable: number;
  unsupported: number;
  unchanged: number;
  /** Unchanged files carrying warnings, which a fix deliberately leaves alone. */
  unchangedWithWarnings: number;
  /** Total operations across every planned file. */
  operations: number;
  /** Image files found but matched by no rule. Silently skipped. */
  ignored: number;
}

export interface FixPlanReport {
  rasterwrightVersion: string;
  /** Always true in this build. Nothing else exists yet. */
  dryRun: true;
  /** Which permissions this run was given. */
  permissions: FixPermissions;
  /** True when every error-level finding is covered by an executable plan. */
  complete: boolean;
  configPath: string;
  root: string;
  summary: FixPlanSummary;
  /**
   * Path collisions batch preflight found across the whole plan set. Empty when
   * the batch is executable. Every conflict corresponds to a `blocked` file.
   */
  conflicts: PlanSetConflict[];
  /**
   * Every file that is not `unchanged`. Unchanged files are counted in the
   * summary and omitted here: `check --json` already describes them, and
   * repeating it would bury the files a fix would actually touch.
   */
  files: FilePlan[];
}

/*
 * ---------------------------------------------------------------------------
 * Fix execution
 *
 * Nothing in this build produces these yet: plain `rasterwright fix` still
 * exits 2. They are here so the execution layer and the report shape are agreed
 * before anything is wired, and so the pieces landing underneath it - the
 * pipeline, the atomic writer, the git survey - can be written against the
 * result they will eventually fill in.
 * ---------------------------------------------------------------------------
 */

/**
 * What a fix run did to one file.
 *
 * - `fixed`     - a verified candidate replaced the original.
 * - `unchanged` - the plan was empty. Nothing was opened for writing.
 * - `skipped`   - a plan exists but this run will not execute it, because it
 *                 needs a permission, is unsupported, is unfixable, or depends
 *                 on a byte-budget search that does not exist yet.
 * - `blocked`   - batch preflight refused the plan's output path.
 * - `failed`    - execution or verification failed. The original is untouched.
 */
export type FixStatus = 'fixed' | 'unchanged' | 'skipped' | 'blocked' | 'failed';

/** What a file looked like, in the terms a report needs to compare before and after. */
export type FixMeasurement = Pick<ImageInfo, 'bytes' | 'width' | 'height' | 'format'>;

export interface FixResult {
  path: string;
  /** Where the file ended up. Differs from `path` only on a rename. */
  outputPath: string;
  status: FixStatus;
  /** The plan as batch preflight left it. */
  plan: FilePlan;
  /**
   * Names of the operations actually executed, in order. Empty unless `status`
   * is `fixed`. Names rather than the operations themselves: `plan` already
   * carries those, and two copies would be two things to keep in agreement.
   */
  applied: PlannedOperation['op'][];
  before: FixMeasurement;
  /** Present only when a new file was written. */
  after?: FixMeasurement;
  /** Bytes saved as a percentage of `before.bytes`. Negative when the file grew. */
  savingsPct?: number;
  /** Why the file failed, was skipped or was blocked. Plain language. */
  reason?: string;
  warnings: string[];
  /** Sorts to the top of the report, and later to the top of the review page. */
  needsAttention: boolean;
}

export interface FixSummary {
  /** Governed images that were inspected. */
  checked: number;
  fixed: number;
  unchanged: number;
  skipped: number;
  blocked: number;
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
  /** True when the run stopped early on SIGINT. */
  interrupted: boolean;
  /** Files reached before the run ended, which differs from `checked` only after an interrupt. */
  completed: number;
  /** Image files found but matched by no rule. Silently skipped. */
  ignored: number;
}

export interface FixReport {
  rasterwrightVersion: string;
  /**
   * Identifies this run. `review` retains it so a page can name the run that
   * produced the files it is describing.
   */
  runId: string;
  /** Recorded so a surprising diff after an upgrade is explainable. */
  engine: { sharp: string; vips: string };
  /** Always false. A dry run produces a `FixPlanReport` instead. */
  dryRun: false;
  permissions: FixPermissions;
  configPath: string;
  root: string;
  summary: FixSummary;
  /** Path collisions batch preflight found. Every one corresponds to a `blocked` result. */
  conflicts: PlanSetConflict[];
  /** Every governed file, `unchanged` ones included. */
  results: FixResult[];
  diagnostics: string[];
}
