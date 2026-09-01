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
