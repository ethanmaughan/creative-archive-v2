/**
 * Core error types. Each one names the spec section it enforces, so a failure in a log
 * or a test name points at the design rule rather than at a line number.
 */

export class CoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A read or write outside the active mode's declared scope (§3). */
export class ScopeViolation extends CoreError {
  readonly operation: 'read' | 'write';
  readonly path: string;
  readonly modeId: string;

  constructor(operation: 'read' | 'write', path: string, modeId: string) {
    super(
      'scope_violation',
      `mode '${modeId}' may not ${operation} '${path}' — outside its declared scope (§3)`,
    );
    this.operation = operation;
    this.path = path;
    this.modeId = modeId;
  }
}

/** A path that escapes the archive root, or is not archive-relative. */
export class PathEscape extends CoreError {
  readonly path: string;

  constructor(path: string) {
    super('path_escape', `path '${path}' escapes the archive root`);
    this.path = path;
  }
}

/** An archive root that is not on the user-level allowlist (§6.0). */
export class ArchiveNotAllowed extends CoreError {
  readonly root: string;
  readonly allowlistPath: string;

  constructor(root: string, allowlistPath: string) {
    super(
      'archive_not_allowed',
      `'${root}' is not an allowed archive root (§6.0). Add it to ${allowlistPath}.`,
    );
    this.root = root;
    this.allowlistPath = allowlistPath;
  }
}

/** An archive root that is not inside a git working tree (D-008). */
export class ArchiveNotVersioned extends CoreError {
  readonly root: string;

  constructor(root: string) {
    super(
      'archive_not_versioned',
      `'${root}' is not inside a git working tree. Writes are only treated as reversible ` +
        `under git (§6.2), so the core refuses to write to an unversioned archive (D-008).`,
    );
    this.root = root;
  }
}

/** A malformed mode manifest, legend, or identity file. */
export class ConfigInvalid extends CoreError {
  readonly file: string;
  readonly detail: string;

  constructor(file: string, detail: string) {
    super('config_invalid', `${file}: ${detail}`);
    this.file = file;
    this.detail = detail;
  }
}

/** A request that does not apply to the current session state. */
export class SessionStateError extends CoreError {
  constructor(detail: string) {
    super('session_state', detail);
  }
}
