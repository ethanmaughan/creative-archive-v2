import { beforeEach, describe, expect, it } from 'vitest';
import { ArchiveIndex } from '../../src/core/retrieval/index.ts';
import { describeSearch, retrieve } from '../../src/core/retrieval/retrieve.ts';
import { loadMode, type Mode } from '../../src/core/modes/mode.ts';
import { MemoryFileStore } from '../../src/core/storage/memory-file-store.ts';

async function corpus(): Promise<MemoryFileStore> {
  const store = new MemoryFileStore();
  await store.write(
    'notes/row-reduction.md',
    '---\ntitle: Row reduction\ntags: [linalg]\ndate: 2026-03-04\n---\n\n## Pivots\n\nChoose the leftmost nonzero pivot.\n',
  );
  await store.write(
    'sessions/2026-08-18T1432Z-a7f3/transcript.md',
    `## 2026-08-18T14:32:11.019Z human\n\nThe eigenvector sign flips whenever I use that pivot. ${'padding '.repeat(120)}\n`,
  );
  await store.write(
    'sessions/2026-08-18T1432Z-a7f3/meta.yaml',
    'id: 2026-08-18T1432Z-a7f3\ntitle: Eigenvector sign\nmode: tutor\nagent_name: Alena\nstarted_at: 2026-08-18T14:32:00.000Z\n',
  );
  return store;
}

describe('retrieve', () => {
  let index: ArchiveIndex;
  let tutor: Mode;

  beforeEach(async () => {
    index = await ArchiveIndex.build(await corpus());
    tutor = await loadMode('tutor');
  });

  it('returns spans with deep links rather than documents (§8)', () => {
    const result = retrieve(index, tutor, 'pivot');
    expect(result.empty).toBe(false);
    for (const span of result.spans) {
      expect(span.deepLink).toMatch(/\.md(#.+)?$/);
      expect(span.title.length).toBeGreaterThan(0);
    }
  });

  it('returns a span whole rather than clipping it mid-sentence', () => {
    const result = retrieve(index, tutor, 'eigenvector');
    const span = result.spans[0]!;
    // The fixture turn is deliberately long; a clip would misquote the source.
    expect(span.text.length).toBeGreaterThan(900);
    expect(span.text).toContain('The eigenvector sign flips');
  });

  it('applies mode read scope to retrieval, not just to file reads (§3)', async () => {
    const walled: Mode = { ...tutor, id: 'walled', scope: { read: ['notes/**'], write: [] } };

    const open = retrieve(index, tutor, 'pivot');
    const restricted = retrieve(index, walled, 'pivot');

    expect(open.spans.some((span) => span.provenance === 'session')).toBe(true);
    expect(restricted.spans.some((span) => span.provenance === 'session')).toBe(false);
    expect(restricted.searched.scope).toEqual(['notes/**']);
  });

  it('carries what was searched on every result (§3.1)', () => {
    const result = retrieve(index, tutor, 'pivot tag:linalg');
    const searched = result.searched;

    expect(searched.terms).toEqual(['pivot']);
    expect(searched.filters).toContain('tags [linalg]');
    expect(searched.generation).toBe(index.generation);
    expect(searched.documentsInArchive).toBe(2);
    expect(searched.scope).toEqual(tutor.scope.read);
  });

  it('reports an empty result as a gap with the search attached', () => {
    const result = retrieve(index, tutor, 'helicopter');
    expect(result.empty).toBe(true);
    expect(result.spans).toEqual([]);
    expect(describeSearch(result.searched)).toContain('terms [helicopter]');
    expect(describeSearch(result.searched)).toContain('index generation 1');
  });

  it('separates "filtered everything out" from "matched nothing"', () => {
    const filteredOut = retrieve(index, tutor, 'pivot tag:cooking');
    expect(filteredOut.searched.candidateSpans).toBe(0);
    expect(describeSearch(filteredOut.searched)).toContain('never tested');

    const unmatched = retrieve(index, tutor, 'helicopter');
    expect(unmatched.searched.candidateSpans).toBeGreaterThan(0);
    expect(describeSearch(unmatched.searched)).not.toContain('never tested');
  });

  it('admits when results are only partial matches', () => {
    const result = retrieve(index, tutor, 'eigenvector helicopter');
    expect(result.searched.matchMode).toBe('any');
    expect(describeSearch(result.searched)).toContain('partial matches');
  });

  it('admits which parts of the query it did not understand', () => {
    const result = retrieve(index, tutor, 'pivot author:me');
    expect(result.searched.ignored).toEqual(['author:me']);
    expect(describeSearch(result.searched)).toContain('author:me');
  });

  it('records that the reference tier does not exist yet (§3.2)', () => {
    const found = retrieve(index, tutor, 'pivot');
    expect(found.searched.tier).toBe('own');
    expect(found.searched.referenceTierAvailable).toBe(false);

    const missing = retrieve(index, tutor, 'helicopter');
    expect(missing.searched.tier).toBeNull();
  });
});
