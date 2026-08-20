import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AppendLog } from './append-log.ts';
import {
  normalizeArchivePath,
  type AppendHandle,
  type FileEntry,
  type FileStore,
} from './file-store.ts';

/** The real store: archive-relative paths resolved against one fixed root. */
export class NodeFileStore implements FileStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  resolve(path: string): string {
    return join(this.root, normalizeArchivePath(path));
  }

  async read(path: string): Promise<string> {
    return readFile(this.resolve(path), 'utf8');
  }

  async write(path: string, content: string): Promise<void> {
    const absolute = this.resolve(path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.resolve(path));
  }

  async list(path: string): Promise<FileEntry[]> {
    const relative = normalizeArchivePath(path);
    const entries = await readdir(join(this.root, relative), { withFileTypes: true });
    const prefix = relative === '.' ? '' : `${relative}/`;
    return entries
      .map((entry) => ({
        path: `${prefix}${entry.name}`,
        kind: entry.isDirectory() ? ('dir' as const) : ('file' as const),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.resolve(path), { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(this.resolve(path), { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    const target = this.resolve(to);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.resolve(from), target);
  }

  openAppend(path: string): AppendHandle {
    return AppendLog.open(this.resolve(path));
  }
}
