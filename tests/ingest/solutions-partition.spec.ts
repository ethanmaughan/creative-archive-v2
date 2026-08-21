import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Archive } from '../../src/core/archive/archive.ts';
import { ScopeViolation } from '../../src/core/errors.ts';
import { ingestFile } from '../../src/core/ingest/ingest.ts';
import { SOLUTIONS_GLOB } from '../../src/core/ingest/manifest.ts';
import { listModes, loadMode, type Mode } from '../../src/core/modes/mode.ts';
import { ArchiveIndex } from '../../src/core/retrieval/index.ts';
import { describeSearch, retrieve } from '../../src/core/retrieval/retrieve.ts';
import { ScopedFileStore } from '../../src/core/storage/scoped-file-store.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

/**
 * §5.5's solutions partition, and the reason it exists: textbook material ships with its
 * answers, and ingested as plain reference that material is retrievable by tutor mode — which
 * then leaks answers neither of you intended, defeating the no-solutions contract (§3.2).
 */
describe('the solutions partition (§5.5)', () => {
  let sandbox: Sandbox;
  let archive: Archive;
  let inbox: string;
  let tutor: Mode;
  let review: Mode;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-partition');
    archive = await sandbox.open();
    inbox = mkdtempSync(join(tmpdir(), 'ca2-inbox-'));
    tutor = await loadMode('tutor');
    review = await loadMode('review');

    writeFileSync(
      join(inbox, 'chapter3.md'),
      '# Chapter 3\n\nRow reduction proceeds by choosing a pivot in each column.\n',
      'utf8',
    );
    writeFileSync(
      join(inbox, 'answers.md'),
      '# Answer key\n\nProblem 4: the eigenvector is (1, -2, 1), and the pivot sign is negative.\n',
      'utf8',
    );

    await ingestFile(archive, {
      sourcePath: join(inbox, 'chapter3.md'),
      type: 'reference',
      subject: 'Row reduction chapter',
      authoredOn: '2026-01-10',
    });
    await ingestFile(archive, {
      sourcePath: join(inbox, 'answers.md'),
      type: 'reference',
      subject: 'Answer key',
      authoredOn: '2026-01-10',
      containsSolutions: true,
    });
  });

  afterEach(() => {
    rmSync(inbox, { recursive: true, force: true });
    sandbox.cleanup();
  });

  it('ships the deny list on the modes that must not read it, and not on review', async () => {
    const byId = new Map((await listModes()).map((mode) => [mode.id, mode]));

    for (const id of ['tutor', 'creative', 'study-partner']) {
      expect(byId.get(id)?.scope.deny, id).toEqual([SOLUTIONS_GLOB]);
    }
    expect(byId.get('review')?.scope.deny).toBeUndefined();
  });

  it('keeps the answer key out of tutor retrieval while leaving the chapter in', async () => {
    const index = await ArchiveIndex.build(archive.store);
    const found = retrieve(index, tutor, 'pivot');

    expect(found.spans.length).toBeGreaterThan(0);
    expect(found.spans.every((span) => !span.deepLink.includes('solutions'))).toBe(true);
    expect(found.spans.some((span) => span.title === 'Row reduction chapter')).toBe(true);
  });

  it('lets review reach it — that is the whole point of a partition rather than a delete', async () => {
    const index = await ArchiveIndex.build(archive.store);
    const found = retrieve(index, review, 'eigenvector');

    expect(found.spans.some((span) => span.deepLink.includes('solutions'))).toBe(true);
    expect(found.spans.some((span) => span.title === 'Answer key')).toBe(true);
  });

  it('finds nothing for a tutor searching the answer key directly', async () => {
    const index = await ArchiveIndex.build(archive.store);
    const found = retrieve(index, tutor, 'eigenvector is');

    // The terms exist in the archive, so this is a partition boundary rather than a gap —
    // and the report says which paths were held out.
    expect(found.spans.every((span) => !span.deepLink.includes('solutions'))).toBe(true);
    expect(describeSearch(found.searched)).toContain('minus ingest/solutions/**');
    expect(found.searched.denied).toEqual([SOLUTIONS_GLOB]);
  });

  it('denies the file itself, not only retrieval', async () => {
    // Metadata a glob cannot see would leave the file readable while only retrieval respected
    // the flag. The deny list sits at the same chokepoint as every other read.
    const store = new ScopedFileStore(archive.store, tutor.scope, tutor.id);
    const path = 'ingest/solutions/2026-01-10-answers/source/answers.md';

    expect(await archive.store.exists(path)).toBe(true);
    await expect(store.read(path)).rejects.toThrow(ScopeViolation);

    const allowed = new ScopedFileStore(archive.store, review.scope, review.id);
    await expect(allowed.read(path)).resolves.toContain('Answer key');
  });

  it('denies the directory itself, not only what is inside it', async () => {
    // Otherwise a mode that cannot open the answer key can still list it, learning that one
    // exists and what it is called — most of what the partition was hiding.
    const store = new ScopedFileStore(archive.store, tutor.scope, tutor.id);
    await expect(store.list('ingest/solutions')).rejects.toThrow(ScopeViolation);
    await expect(store.exists('ingest/solutions')).rejects.toThrow(ScopeViolation);

    // The parent is still readable: denying a subtree is not denying the tree above it.
    await expect(store.list('ingest')).resolves.toBeDefined();
  });

  it('deny beats allow, even for a path the read list explicitly names', () => {
    const contradictory: Mode = {
      ...tutor,
      scope: { read: ['ingest/solutions/**', '**'], write: [], deny: [SOLUTIONS_GLOB] },
    };
    const store = new ScopedFileStore(archive.store, contradictory.scope, 'contradictory');
    expect(store.read('ingest/solutions/x/source/a.md')).rejects.toThrow(ScopeViolation);
  });

  it('denies writes into the partition as well as reads', async () => {
    const store = new ScopedFileStore(
      archive.store,
      { read: ['**'], write: ['**'], deny: [SOLUTIONS_GLOB] },
      'writer',
    );
    await expect(store.write('ingest/solutions/x/source/a.md', 'no')).rejects.toThrow(
      ScopeViolation,
    );
    await expect(store.write('ingest/x/source/a.md', 'yes')).resolves.toBeUndefined();
  });
});
