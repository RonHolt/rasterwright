/**
 * Rasterwright's exit codes.
 *
 *   0  clean   - no error-level findings. Warnings and notes do not fail a run.
 *   1  errors  - at least one error-level finding, including an unreadable image
 *   2  failure - configuration or runtime failure; nothing was checked
 */
export const EXIT_CLEAN = 0;
export const EXIT_ERRORS = 1;
export const EXIT_ERROR = 2;

/** A user-facing failure that should exit with code 2 and no stack trace. */
export class RasterwrightError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'RasterwrightError';
    this.hint = hint;
  }
}

/** A problem with `.rasterwright.yml`. */
export class ConfigError extends RasterwrightError {
  constructor(message: string, hint?: string) {
    super(message, hint);
    this.name = 'ConfigError';
  }
}
