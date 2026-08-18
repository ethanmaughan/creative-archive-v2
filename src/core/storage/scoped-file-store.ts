import { ScopeViolation } from '../errors.ts';
import { matchesAnyGlob } from './glob.ts';
import { normalizeArchivePath, type AppendHandle, type FileStore } from './file-store.ts';

export interface Scope {
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/**
 * Standalone scope checks, so a caller holding the unscoped store can still prove a path is
 * in scope before acting on it. Intake needs exactly this: the scratch buffer lives outside
 * every mode's scope, so flushing it into the session folder is a rename whose *target* must
 * be checked even though its source cannot be.
 */
export function assertScopeRead(scope: Scope, modeId: string, path: string): string {
  const normalized = normalizeArchivePath(path);
  if (!matchesAnyGlob(scope.read, normalized)) {
    throw new ScopeViolation('read', normalized, modeId);
  }
  return normalized;
}

export function assertScopeWrite(scope: Scope, modeId: string, path: string): string {
  const normalized = normalizeArchivePath(path);
  if (!matchesAnyGlob(scope.write, normalized)) {
    throw new ScopeViolation('write', normalized, modeId);
  }
  return normalized;
}

/**
 * Mode scope enforcement (§3), applied at the storage layer rather than in each tool.
 *
 * One chokepoint is the whole point: a tool that forgets to check scope is a bug you find
 * in production, whereas a store that cannot be reached without checking has no such
 * failure mode. Adding a tool in a later step therefore cannot widen scope by omission.
 *
 * This wraps the *agent-facing* surface only. The core's own bookkeeping — identity,
 * scratch buffers, the open-session pointer under `.creative-archive/` — goes through the
 * unscoped store, because that state is not the agent's to reach in the first place.
 */
export class ScopedFileStore implements FileStore {
  readonly root: string;
  readonly modeId: string;
  readonly scope: Scope;
  #inner: FileStore;

  constructor(inner: FileStore, scope: Scope, modeId: string) {
    this.#inner = inner;
    this.scope = scope;
    this.modeId = modeId;
    this.root = inner.root;
  }

  #checkRead(path: string): string {
    return assertScopeRead(this.scope, this.modeId, path);
  }

  #checkWrite(path: string): string {
    return assertScopeWrite(this.scope, this.modeId, path);
  }

  resolve(path: string): string {
    return this.#inner.resolve(this.#checkRead(path));
  }

  async read(path: string): Promise<string> {
    return this.#inner.read(this.#checkRead(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.#inner.exists(this.#checkRead(path));
  }

  async list(path: string): Promise<string[]> {
    return this.#inner.list(this.#checkRead(path));
  }

  async write(path: string, content: string): Promise<void> {
    return this.#inner.write(this.#checkWrite(path), content);
  }

  async mkdir(path: string): Promise<void> {
    return this.#inner.mkdir(this.#checkWrite(path));
  }

  async remove(path: string): Promise<void> {
    return this.#inner.remove(this.#checkWrite(path));
  }

  async rename(from: string, to: string): Promise<void> {
    return this.#inner.rename(this.#checkWrite(from), this.#checkWrite(to));
  }

  openAppend(path: string): AppendHandle {
    return this.#inner.openAppend(this.#checkWrite(path));
  }
}
