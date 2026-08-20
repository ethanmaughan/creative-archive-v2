import { beforeEach, describe, expect, it } from 'vitest';
import { ArchiveIndex } from '../../src/core/retrieval/index.ts';
import { parseQuery } from '../../src/core/retrieval/query.ts';
import { MemoryFileStore } from '../../src/core/storage/memory-file-store.ts';

async function corpus(): Promise<MemoryFileStore> {
  const store = new MemoryFileStore();

  await store.write(
    'notes/row-reduction.md',
    `---
title: Row reduction
tags: [linalg]
date: 2026-03-04
---

## Pivots

Choose the leftmost nonzero pivot entry, then eliminate below it.

## Back substitution

Work upward from the last pivot to recover each variable.
`,
  );

  await store.write(
    'notes/staging.md',
    `---
title: Staging the mission chapters
tags: [novel]
date: 2026-05-20
---

## Act II

The mission chapters repeat because each one restates the stakes.
`,
  );

  await store.write(
    'sessions/2026-08-18T1432Z-a7f3/transcript.md',
    `## 2026-08-18T14:32:11.019Z human

The eigenvector sign keeps coming out negative when I eliminate below the pivot.

## 2026-08-18T14:32:20.000Z agent

Which pivot did you choose?
`,
  );
  await store.write(
    'sessions/2026-08-18T1432Z-a7f3/meta.yaml',
    'id: 2026-08-18T1432Z-a7f3\ntitle: Eigenvector sign\nmode: tutor\nagent_name: Alena\nstarted_at: 2026-08-18T14:32:00.000Z\n',
  );

  return store;
}

describe('ArchiveIndex', () => {
  let store: MemoryFileStore;
  let index: ArchiveIndex;

  beforeEach(async () => {
    store = await corpus();
    index = await ArchiveIndex.build(store);
  });

  it('reports what it built, so a thin index is visible rather than mysterious', () => {
    expect(index.stats.documents).toBe(3);
    expect(index.stats.spans).toBe(5);
    expect(index.stats.filesRead).toBe(3);
    expect(index.stats.tokens).toBeGreaterThan(20);
    expect(index.stats.skipped).toEqual([]);
    expect(index.generation).toBe(1);
  });

  it('increments the generation on rebuild, so a report can name the index it used', async () => {
    const rebuilt = await ArchiveIndex.build(store, index);
    expect(rebuilt.generation).toBe(2);
    expect((await ArchiveIndex.build(store, rebuilt)).generation).toBe(3);
  });

  it('returns spans, not documents', () => {
    const outcome = index.search(parseQuery('pivot'));
    expect(outcome.hits.length).toBeGreaterThan(1);
    for (const hit of outcome.hits) {
      expect(hit.span.deepLink).toContain('#');
      expect(hit.span.text.length).toBeLessThan(400);
    }
  });

  it('requires every term when it can, and says so', () => {
    const outcome = index.search(parseQuery('eigenvector pivot'));
    expect(outcome.matchMode).toBe('all');
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0]!.document.provenance).toBe('session');
    expect([...outcome.hits[0]!.matched].sort()).toEqual(['eigenvector', 'pivot']);
  });

  it('relaxes to a partial match rather than returning nothing, and flags the relaxation', () => {
    const outcome = index.search(parseQuery('eigenvector unicycle'));
    expect(outcome.matchMode).toBe('any');
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits[0]!.matched).toEqual(['eigenvector']);
  });

  it('returns nothing at all when no term is in the archive', () => {
    const outcome = index.search(parseQuery('helicopter'));
    expect(outcome.hits).toEqual([]);
    expect(outcome.candidates).toBe(5);
  });

  it('distinguishes filtered-out from unmatched via the candidate count', () => {
    const outcome = index.search(parseQuery('pivot tag:cooking'));
    expect(outcome.hits).toEqual([]);
    expect(outcome.candidates).toBe(0);
  });

  it('filters by tag, date range, mode, and provenance', () => {
    expect(index.search(parseQuery('tag:novel')).hits).toHaveLength(1);
    expect(index.search(parseQuery('pivot in:note')).hits.length).toBeGreaterThan(0);
    // Both turns of the session mention a pivot, and both are separate spans.
    expect(index.search(parseQuery('pivot in:session')).hits).toHaveLength(2);
    expect(index.search(parseQuery('mode:tutor')).hits).toHaveLength(2);
    expect(index.search(parseQuery('after:2026-04-01')).hits.length).toBe(3);
    expect(index.search(parseQuery('before:2026-04-01')).hits.length).toBe(2);
  });

  it('looks up a heading', () => {
    const outcome = index.search(parseQuery('heading:"back substitution"'));
    expect(outcome.matchMode).toBe('filter-only');
    expect(outcome.hits).toHaveLength(1);
    expect(outcome.hits[0]!.span.heading).toBe('Back substitution');
  });

  it('honours the limit', () => {
    expect(index.search(parseQuery('pivot limit:1')).hits).toHaveLength(1);
  });

  it('ranks a rare term above a common one', () => {
    const outcome = index.search(parseQuery('eigenvector the'));
    expect(outcome.hits[0]!.matched).toContain('eigenvector');
  });

  it('applies a permit before ranking, so out-of-scope spans cannot take a result slot', () => {
    const unrestricted = index.search(parseQuery('pivot limit:50'));
    const notesOnly = index.search(parseQuery('pivot limit:50'), (path) =>
      path.startsWith('notes/'),
    );

    expect(unrestricted.hits.some((hit) => hit.document.provenance === 'session')).toBe(true);
    expect(notesOnly.hits.some((hit) => hit.document.provenance === 'session')).toBe(false);
    expect(notesOnly.candidates).toBeLessThan(unrestricted.candidates);
  });

  it('lists each document once regardless of how many spans it has', () => {
    expect([...index.listDocuments().map((document) => document.path)].sort()).toEqual([
      'notes/row-reduction.md',
      'notes/staging.md',
      'sessions/2026-08-18T1432Z-a7f3/transcript.md',
    ]);
  });

  it('builds an empty archive without complaint', async () => {
    const empty = await ArchiveIndex.build(new MemoryFileStore());
    expect(empty.stats.documents).toBe(0);
    expect(empty.search(parseQuery('anything')).hits).toEqual([]);
  });
});
