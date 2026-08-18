import { posix } from 'node:path';
import { normalizeArchivePath, type AppendHandle, type FileStore } from './file-store.ts';

/**
 * In-memory store for unit tests of scope and lifecycle logic. The durability invariants
 * are tested against the real filesystem — a fake cannot prove anything about fsync.
 */
export class MemoryFileStore implements FileStore {
  readonly root = '/memory';
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  resolve(path: string): string {
    return posix.join(this.root, normalizeArchivePath(path));
  }

  async read(path: string): Promise<string> {
    const key = normalizeArchivePath(path);
    const content = this.files.get(key);
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
    }
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    const key = normalizeArchivePath(path);
    this.files.set(key, content);
    this.#recordParents(key);
  }

  async exists(path: string): Promise<boolean> {
    const key = normalizeArchivePath(path);
    return this.files.has(key) || this.dirs.has(key);
  }

  async list(path: string): Promise<string[]> {
    const key = normalizeArchivePath(path);
    const prefix = `${key}/`;
    const children = new Set<string>();
    for (const candidate of [...this.files.keys(), ...this.dirs]) {
      if (!candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      const head = rest.split('/')[0]!;
      children.add(`${key}/${head}`);
    }
    return [...children].sort();
  }

  async mkdir(path: string): Promise<void> {
    const key = normalizeArchivePath(path);
    this.dirs.add(key);
    this.#recordParents(key);
  }

  async remove(path: string): Promise<void> {
    const key = normalizeArchivePath(path);
    const prefix = `${key}/`;
    this.files.delete(key);
    this.dirs.delete(key);
    for (const candidate of [...this.files.keys()]) {
      if (candidate.startsWith(prefix)) this.files.delete(candidate);
    }
    for (const candidate of [...this.dirs]) {
      if (candidate.startsWith(prefix)) this.dirs.delete(candidate);
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizeArchivePath(from);
    const target = normalizeArchivePath(to);
    const content = this.files.get(source);
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: ${source}`), { code: 'ENOENT' });
    }
    this.files.delete(source);
    this.files.set(target, content);
    this.#recordParents(target);
  }

  openAppend(path: string): AppendHandle {
    const key = normalizeArchivePath(path);
    const files = this.files;
    if (!files.has(key)) files.set(key, '');
    this.#recordParents(key);

    let open = true;
    const handle: AppendHandle = {
      path: key,
      get isOpen() {
        return open;
      },
      append(text: string) {
        if (!open) throw new Error(`append log '${key}' is closed`);
        files.set(key, (files.get(key) ?? '') + text);
      },
      sync() {},
      appendAndSync(text: string) {
        handle.append(text);
      },
      close() {
        open = false;
      },
    };
    return handle;
  }

  #recordParents(key: string): void {
    let parent = posix.dirname(key);
    while (parent !== '.' && parent !== '/' && parent !== '') {
      this.dirs.add(parent);
      parent = posix.dirname(parent);
    }
  }
}
