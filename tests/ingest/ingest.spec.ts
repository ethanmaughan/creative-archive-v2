import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Archive } from '../../src/core/archive/archive.ts';
import { CoreError } from '../../src/core/errors.ts';
import { ingestFile } from '../../src/core/ingest/ingest.ts';
import { ingestId, readIngestManifest } from '../../src/core/ingest/manifest.ts';
import { ArchiveIndex } from '../../src/core/retrieval/index.ts';
import { parseQuery } from '../../src/core/retrieval/query.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

describe('ingest (§5.5, §10.1)', () => {
  let sandbox: Sandbox;
  let archive: Archive;
  let inbox: string;

  const file = (name: string, content: string): string => {
    const path = join(inbox, name);
    writeFileSync(path, content, 'utf8');
    return path;
  };

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-ingest');
    archive = await sandbox.open();
    inbox = mkdtempSync(join(tmpdir(), 'ca2-inbox-'));
  });

  afterEach(() => {
    rmSync(inbox, { recursive: true, force: true });
    sandbox.cleanup();
  });

  const add = (overrides: Partial<Parameters<typeof ingestFile>[1]> = {}) =>
    ingestFile(archive, {
      sourcePath: file(
        'pset4.md',
        '# Problem 4\n\nI took the leftmost pivot without checking.\n',
      ),
      type: 'worked-problem',
      subject: 'Linear algebra pset 4',
      authoredOn: '2026-08-17',
      ...overrides,
    });

  it('files the original under source/ and records what was declared', async () => {
    const result = await add();

    expect(result.manifest.id).toBe('2026-08-17-pset4');
    expect(result.wrote).toContain('ingest/2026-08-17-pset4/source/pset4.md');

    const manifest = await readIngestManifest(archive.store, result.manifest.id);
    expect(manifest.type).toBe('worked-problem');
    expect(manifest.subject).toBe('Linear algebra pset 4');
    expect(manifest.authored_on).toBe('2026-08-17');
    expect(manifest.parsed_at).toBeNull();
  });

  it('copies the content verbatim', async () => {
    const result = await add();
    const copied = await archive.store.read(
      `ingest/${result.manifest.id}/source/${result.manifest.source}`,
    );
    expect(copied).toBe('# Problem 4\n\nI took the leftmost pivot without checking.\n');
  });

  it('never infers the type, and says what to do instead', async () => {
    await expect(add({ type: 'homework' })).rejects.toThrow(/unknown type 'homework'/);
    await expect(add({ type: 'homework' })).rejects.toThrow(/it is 'notes'/);
    await expect(add({ type: 'homework' })).rejects.toThrow(/never guess upward/);
  });

  it('requires the authored date, not the upload date (§10.1)', async () => {
    await expect(add({ authoredOn: 'yesterday' })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(add({ authoredOn: '2026-8-1' })).rejects.toThrow(CoreError);
  });

  it('requires a subject', async () => {
    await expect(add({ subject: '   ' })).rejects.toThrow(/subject is required/);
  });

  it('refuses a source that is not a file', async () => {
    await expect(add({ sourcePath: join(inbox, 'nope.md') })).rejects.toThrow(/is not a file/);
    await expect(add({ sourcePath: inbox })).rejects.toThrow(/is not a file/);
  });

  it('accepts the text formats it can actually read', async () => {
    for (const name of ['notes.txt', 'solver.py', 'data.csv', 'paper.tex']) {
      const result = await add({ sourcePath: file(name, 'content\n'), subject: name });
      expect(result.manifest.source).toBe(name);
    }
  });

  it('refuses a format nothing here can read, rather than filing an empty item', async () => {
    await expect(add({ sourcePath: file('scan.pdf', 'not really a pdf') })).rejects.toThrow(
      /not a text format this build can read/,
    );
  });

  it('files a scanned original but marks it unverified (§5.5, §10.2)', async () => {
    const result = await add({ sourcePath: file('scan.pdf', 'binary-ish'), scanned: true });

    expect(result.needsVerification).toBe(true);
    expect(result.manifest.scanned).toBe(true);
    expect(result.manifest.verified).toBe(false);
  });

  it('refuses the solutions flag while the partition it routes to does not exist', async () => {
    // Accepting it would file material as protected while leaving it readable — a claimed
    // protection is worse than an absent one.
    await expect(add({ containsSolutions: true })).rejects.toThrow(
      /cannot be honoured yet.*not built/s,
    );
  });

  it('gives a second item on the same day its own id, and never reuses one', async () => {
    const first = await add();
    const second = await add();

    expect(second.manifest.id).toBe(`${first.manifest.id}-2`);
    expect(await archive.store.exists(`ingest/${first.manifest.id}/meta.yaml`)).toBe(true);
    expect(await archive.store.exists(`ingest/${second.manifest.id}/meta.yaml`)).toBe(true);
  });

  it('builds an id from the authored date and the filename', () => {
    expect(ingestId('2026-08-17', 'linalg pset4.md')).toBe('2026-08-17-linalg-pset4');
    expect(ingestId('2026-08-17', '  ')).toBe('2026-08-17');
  });
});

describe('ingested material in retrieval (§5.5)', () => {
  let sandbox: Sandbox;
  let archive: Archive;
  let inbox: string;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-ingest-retrieval');
    archive = await sandbox.open();
    inbox = mkdtempSync(join(tmpdir(), 'ca2-inbox-'));

    writeFileSync(
      join(inbox, 'pset4.md'),
      '# Problem 4\n\nThe eigenvector sign came out negative because of the pivot.\n',
      'utf8',
    );
    await ingestFile(archive, {
      sourcePath: join(inbox, 'pset4.md'),
      type: 'worked-problem',
      subject: 'Linear algebra pset 4',
      authoredOn: '2026-08-17',
    });
  });

  afterEach(() => {
    rmSync(inbox, { recursive: true, force: true });
    sandbox.cleanup();
  });

  it('carries provenance through retrieval, so it never reads as a conclusion', async () => {
    const index = await ArchiveIndex.build(archive.store);
    const hits = index.search(parseQuery('eigenvector')).hits;

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.document.provenance).toBe('ingest');
    expect(hits[0]!.document.title).toBe('Linear algebra pset 4');
    // The authored date, not the day it was brought in.
    expect(hits[0]!.document.date).toBe('2026-08-17');
  });

  it('is filterable as its own provenance', async () => {
    const index = await ArchiveIndex.build(archive.store);
    expect(index.search(parseQuery('eigenvector in:ingest')).hits).toHaveLength(1);
    expect(index.search(parseQuery('eigenvector in:note')).hits).toHaveLength(0);
  });

  it('indexes an original whatever its extension', async () => {
    writeFileSync(join(inbox, 'solver.py'), '# gaussian elimination\nprint("pivot")\n', 'utf8');
    await ingestFile(archive, {
      sourcePath: join(inbox, 'solver.py'),
      type: 'artifact',
      subject: 'Elimination solver',
      authoredOn: '2026-08-18',
    });

    const index = await ArchiveIndex.build(archive.store);
    const hits = index.search(parseQuery('gaussian')).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.document.title).toBe('Elimination solver');
  });

  it('does not index a scanned original, because there is no text in it yet', async () => {
    writeFileSync(join(inbox, 'scan.pdf'), 'binary-ish', 'utf8');
    const result = await ingestFile(archive, {
      sourcePath: join(inbox, 'scan.pdf'),
      type: 'worked-problem',
      subject: 'Scanned pset 5',
      authoredOn: '2026-08-19',
      scanned: true,
    });

    const index = await ArchiveIndex.build(archive.store);
    expect(index.listDocuments().some((doc) => doc.path.includes(result.manifest.id))).toBe(
      false,
    );
  });

  it('never indexes the manifest as if it were content', async () => {
    const index = await ArchiveIndex.build(archive.store);
    expect(index.listDocuments().every((doc) => !doc.path.endsWith('meta.yaml'))).toBe(true);
  });
});
