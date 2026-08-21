import { ScopeViolation } from '../errors.ts';
import { matchesAnyGlob } from './glob.ts';
import {
  normalizeArchivePath,
  type AppendHandle,
  type FileEntry,
  type FileStore,
} from './file-store.ts';

export interface Scope {
  readonly read: readonly string[];
  readonly write: readonly string[];
  /**
   * Checked before `read` and `write`, and it wins.
   *
   * §5.5 needs material flagged as containing solutions to be unreadable by `tutor` and
   * readable by `review`. An allow-list of globs cannot express "everything except this",
   * and enumerating the rest would mean a mode losing access to any directory added later.
   * One deny list, evaluated first, expresses the partition with the machinery already here
   * — and because it sits at the same chokepoint, it covers file reads and retrieval alike.
   */
  readonly deny?: readonly string[];
}

/**
 * Deny wins. A path listed in `deny` is out of scope no matter what `read`/`write` allow.
 *
 * Allow narrowly, deny broadly: a deny of `a/**` also denies `a` itself, which an allow of
 * `a/**` deliberately does not grant. The asymmetry is the point. Granting a subtree should
 * not hand over the directory entry as well — but denying one and still permitting a listing
 * of it lets a mode read the ids and titles inside a partition it cannot open, which is most
 * of what the partition was hiding.
 */
export function scopeDenies(scope: Scope, path: string): boolean {
  if (scope.deny === undefined) return false;
  if (matchesAnyGlob(scope.deny, path)) return true;

  return scope.deny.some(
    (pattern) => pattern.endsWith('/**') && path === pattern.slice(0, -'/**'.length),
  );
}

/** Whether a mode may read this path at all — the predicate retrieval filters on. */
export function scopePermitsRead(scope: Scope, path: string): boolean {
  return !scopeDenies(scope, path) && matchesAnyGlob(scope.read, path);
}

/**
 * Standalone scope checks, so a caller holding the unscoped store can still prove a path is
 * in scope before acting on it. Intake needs exactly this: the scratch buffer lives outside
 * every mode's scope, so flushing it into the session folder is a rename whose *target* must
 * be checked even though its source cannot be.
 */
export function assertScopeRead(scope: Scope, modeId: string, path: string): string {
  const normalized = normalizeArchivePath(path);
  if (!scopePermitsRead(scope, normalized)) {
    throw new ScopeViolation('read', normalized, modeId);
  }
  return normalized;
}

export function assertScopeWrite(scope: Scope, modeId: string, path: string): string {
  const normalized = normalizeArchivePath(path);
  if (scopeDenies(scope, normalized) || !matchesAnyGlob(scope.write, normalized)) {
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

  async list(path: string): Promise<FileEntry[]> {
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
