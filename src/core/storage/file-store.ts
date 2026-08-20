import { posix } from 'node:path';
import { PathEscape } from '../errors.ts';

/**
 * A handle onto an append-only file. `AppendLog` is the real implementation; the in-memory
 * file store returns an equivalent so scope and lifecycle logic can be unit-tested without
 * touching disk.
 */
export interface AppendHandle {
  readonly path: string;
  readonly isOpen: boolean;
  append(text: string): void;
  sync(): void;
  appendAndSync(text: string): void;
  close(): void;
}

/**
 * One entry in a directory listing. The kind is carried because walking the archive needs
 * it, and inferring it by attempting a listing and catching ENOTDIR turns a normal case
 * into an exception path.
 */
export interface FileEntry {
  readonly path: string;
  readonly kind: 'file' | 'dir';
}

/**
 * The storage seam (§2.1). Every path is an archive-relative POSIX path with no leading
 * slash — that is what makes mode scope globs (§3) meaningful, and it keeps the core from
 * ever handling a host-absolute path except at the boundary.
 */
export interface FileStore {
  readonly root: string;
  resolve(path: string): string;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<FileEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  openAppend(path: string): AppendHandle;
}

/**
 * Normalize an archive-relative path, rejecting anything that leaves the archive.
 * Called on the way into every store operation, before scope is even consulted — an
 * escaping path is not a scope question, it is a malformed one.
 */
export function normalizeArchivePath(path: string): string {
  if (path.length === 0) {
    throw new PathEscape(path);
  }
  if (posix.isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes('\\')) {
    throw new PathEscape(path);
  }

  const normalized = posix.normalize(path);
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    throw new PathEscape(path);
  }

  // '.' is the archive root. Walking the archive needs a way to name it, and the
  // alternative — letting the scanner reach past the store to node:fs — would put a second
  // route to the filesystem beside the one that enforces scope.
  if (normalized === '.') return '.';

  const trimmed = normalized.replace(/\/+$/, '');
  if (trimmed === '') {
    throw new PathEscape(path);
  }

  return trimmed;
}
