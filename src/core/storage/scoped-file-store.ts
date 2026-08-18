import { ScopeViolation } from '../errors.ts';
import { matchesAnyGlob } from './glob.ts';
import { normalizeArchivePath, type AppendHandle, type FileStore } from './file-store.ts';

export interface Scope {
  readonly read: readonly string[];
  readonly write: readonly string[];
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
    const normalized = normalizeArchivePath(path);
    if (!matchesAnyGlob(this.scope.read, normalized)) {
      throw new ScopeViolation('read', normalized, this.modeId);
    }
    return normalized;
  }

  #checkWrite(path: string): string {
    const normalized = normalizeArchivePath(path);
    if (!matchesAnyGlob(this.scope.write, normalized)) {
      throw new ScopeViolation('write', normalized, this.modeId);
    }
    return normalized;
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
