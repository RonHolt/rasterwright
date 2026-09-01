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
  /** Remove EXIF / XMP / ICC. Default true. */
  stripMetadata?: boolean;
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

export type CheckName =
  | 'maxWidth'
  | 'maxHeight'
  | 'maxBytes'
  | 'format'
  | 'metadata'
  | 'colorSpace'
  | 'orientation';

/**
 * Whether a future `fix` could resolve a violation.
 *
 * - `yes`     - a deterministic transform resolves it.
 * - `no`      - it cannot be resolved safely (e.g. JPEG cannot hold transparency).
 * - `unknown` - nothing blocks it, but the answer depends on encoding results
 *               that `check` deliberately does not produce. `maxBytes` is the
 *               only check that lands here.
 */
export type Fixability = 'yes' | 'no' | 'unknown';

export interface Violation {
  path: string;
  /** The glob whose value produced this violation, or '(defaults)'. */
  rule: string;
  check: CheckName;
  actual: string | number;
  allowed: string | number;
  fixable: Fixability;
  /** Why it is not fixable, or what a fix would have to do. */
  message: string;
}

/** A non-blocking observation. Never affects the exit code. */
export interface Note {
  code: 'colorSpaceUnknown' | 'transparency' | 'animated' | 'ruleGlobExcludesTargetFormat';
  message: string;
}

export type FileStatus = 'compliant' | 'violating' | 'error';

export interface FileResult {
  path: string;
  status: FileStatus;
  /** Undefined only when `status` is 'error'. */
  image?: ImageInfo;
  /** The merged policy that applied to this file. Undefined when `status` is 'error'. */
  policy?: RuleBody;
  matchedGlobs: string[];
  violations: Violation[];
  notes: Note[];
  /** Aggregate fixability across `violations`. 'yes' when there are none. */
  fixable: Fixability;
  /** Present when `status` is 'error'. */
  error?: string;
}

export interface CheckSummary {
  /** Governed images that were inspected. */
  checked: number;
  compliant: number;
  violating: number;
  /** Total violation count across all files. */
  violations: number;
  /** Files that could not be inspected (corrupt, unreadable, unsupported). */
  errors: number;
  /** Image files found but matched by no rule. Silently skipped. */
  ignored: number;
}

export interface CheckReport {
  rasterwrightVersion: string;
  clean: boolean;
  /** Absolute path to the config that was used. */
  configPath: string;
  /** Absolute path to the project root (the directory holding the config). */
  root: string;
  summary: CheckSummary;
  files: FileResult[];
}
