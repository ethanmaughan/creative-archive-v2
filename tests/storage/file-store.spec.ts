import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathEscape } from '../../src/core/errors.ts';
import { normalizeArchivePath } from '../../src/core/storage/file-store.ts';
import { NodeFileStore } from '../../src/core/storage/node-file-store.ts';

describe('normalizeArchivePath', () => {
  it('accepts archive-relative posix paths', () => {
    expect(normalizeArchivePath('sessions/a/transcript.md')).toBe('sessions/a/transcript.md');
    expect(normalizeArchivePath('./notes/x.md')).toBe('notes/x.md');
    expect(normalizeArchivePath('sessions/')).toBe('sessions');
  });

  it('rejects anything that could leave the archive', () => {
    for (const bad of [
      '/etc/passwd',
      '../outside.md',
      'a/../../b.md',
      '',
      '.',
      'C:/x',
      'a\\b',
    ]) {
      expect(() => normalizeArchivePath(bad), bad).toThrow(PathEscape);
    }
  });

  it('allows .. that stays inside the archive', () => {
    expect(normalizeArchivePath('sessions/a/../b.md')).toBe('sessions/b.md');
  });
});

describe('NodeFileStore', () => {
  let root: string;
  let store: NodeFileStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ca2-store-'));
    store = new NodeFileStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates parent directories on write', async () => {
    await store.write('sessions/deep/nested/file.md', 'hello');
    expect(readFileSync(join(root, 'sessions/deep/nested/file.md'), 'utf8')).toBe('hello');
    expect(await store.read('sessions/deep/nested/file.md')).toBe('hello');
  });

  it('lists one level of entries as archive-relative paths', async () => {
    await store.write('sessions/a/transcript.md', '');
    await store.write('sessions/b/transcript.md', '');
    expect(await store.list('sessions')).toEqual(['sessions/a', 'sessions/b']);
  });

  it('renames across directories, creating the target parent', async () => {
    await store.write('.creative-archive/scratch/pending.md', 'preamble');
    await store.rename('.creative-archive/scratch/pending.md', 'sessions/x/transcript.md');
    expect(await store.exists('.creative-archive/scratch/pending.md')).toBe(false);
    expect(await store.read('sessions/x/transcript.md')).toBe('preamble');
  });

  it('refuses to resolve a path outside its root', () => {
    expect(() => store.resolve('../escape.md')).toThrow(PathEscape);
  });
});
