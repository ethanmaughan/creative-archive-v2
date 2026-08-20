import { describe, expect, it } from 'vitest';
import { headingSpans, scanArchive, splitFrontmatter } from '../../src/core/retrieval/scan.ts';
import { MemoryFileStore } from '../../src/core/storage/memory-file-store.ts';

const NOTE = `---
title: Row reduction
tags: [linalg, '#method']
date: 2026-03-04
---

Preamble before any heading.

## Pivots

Choose the leftmost nonzero entry.

## Back substitution

Work upward from the last pivot.
`;

const TRANSCRIPT = `## 2026-08-18T14:32:07.412Z agent

What's going on?

## 2026-08-18T14:32:11.019Z human

The eigenvector part of problem 4 keeps coming out negative.

## 2026-08-18T14:32:15.550Z footnote

sign flip again
`;

const META = `id: 2026-08-18T1432Z-a7f3
title: Eigenvector sign
mode: tutor
agent_name: Alena
started_at: 2026-08-18T14:32:00.000Z
`;

async function archive(): Promise<MemoryFileStore> {
  const store = new MemoryFileStore();
  await store.write('notes/row-reduction.md', NOTE);
  await store.write('sessions/2026-08-18T1432Z-a7f3/transcript.md', TRANSCRIPT);
  await store.write('sessions/2026-08-18T1432Z-a7f3/meta.yaml', META);
  await store.write('.creative-archive/identity.yaml', 'name: Alena\npersonality: dry\n');
  await store.write(
    '.creative-archive/scratch/pending-x.md',
    '## 2026-01-01T00:00:00.000Z human\n\nsecret\n',
  );
  await store.write('.git/COMMIT_EDITMSG', 'not markdown anyway');
  await store.write('README.txt', 'ignored, not markdown');
  return store;
}

describe('splitFrontmatter', () => {
  it('separates YAML from body and reports where the body starts', () => {
    const { data, body, bodyStartLine } = splitFrontmatter(NOTE);
    expect(data.title).toBe('Row reduction');
    expect(body.startsWith('\nPreamble')).toBe(true);
    expect(bodyStartLine).toBe(6);
  });

  it('treats a file with no frontmatter as all body', () => {
    const { data, body } = splitFrontmatter('# Just a heading\n\ntext\n');
    expect(data).toEqual({});
    expect(body).toBe('# Just a heading\n\ntext\n');
  });

  it('treats unterminated or malformed frontmatter as body rather than throwing', () => {
    expect(splitFrontmatter('---\ntitle: x\n').data).toEqual({});
    expect(splitFrontmatter('---\n: : :\nnope\n---\nbody\n').body).toContain('nope');
  });
});

describe('headingSpans', () => {
  it('splits at headings and keeps the pre-heading text as its own span', () => {
    const spans = headingSpans(
      'notes/x.md',
      '\nIntro text.\n\n## One\n\na\n\n## Two\n\nb\n',
      1,
    );
    expect(spans.map((span) => span.heading)).toEqual([null, 'One', 'Two']);
    expect(spans[0]!.text).toBe('Intro text.');
    expect(spans[1]!.deepLink).toBe('notes/x.md#one');
  });

  it('gives a heading-less file a single span', () => {
    const spans = headingSpans('notes/x.md', 'just prose\n', 1);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.deepLink).toBe('notes/x.md');
  });

  it('includes the heading text in the span, so a heading is searchable', () => {
    const spans = headingSpans('notes/x.md', '## Back substitution\n\nwork upward\n', 1);
    expect(spans[0]!.text).toContain('Back substitution');
    expect(spans[0]!.text).toContain('work upward');
  });
});

describe('scanArchive', () => {
  it('indexes notes with frontmatter metadata', async () => {
    const { documents } = await scanArchive(await archive());
    const note = documents.find((document) => document.path === 'notes/row-reduction.md');

    expect(note?.provenance).toBe('note');
    expect(note?.title).toBe('Row reduction');
    expect(note?.date).toBe('2026-03-04');
    expect(note?.tags).toEqual(['linalg', 'method']);
    expect(note?.spans.map((span) => span.heading)).toEqual([
      null,
      'Pivots',
      'Back substitution',
    ]);
  });

  it('reads session metadata from the sibling meta.yaml, since transcripts have no frontmatter', async () => {
    const { documents } = await scanArchive(await archive());
    const session = documents.find((document) => document.provenance === 'session');

    expect(session?.title).toBe('Eigenvector sign');
    expect(session?.mode).toBe('tutor');
    expect(session?.agent).toBe('Alena');
    expect(session?.date).toBe('2026-08-18');
  });

  it('makes each conversational turn its own span, with the timestamp as the anchor', async () => {
    const { documents } = await scanArchive(await archive());
    const session = documents.find((document) => document.provenance === 'session')!;

    expect(session.spans).toHaveLength(3);
    expect(session.spans.map((span) => span.heading)).toEqual(['agent', 'human', 'footnote']);
    expect(session.spans[1]!.deepLink).toBe(
      'sessions/2026-08-18T1432Z-a7f3/transcript.md#2026-08-18T14:32:11.019Z',
    );
  });

  it('never indexes core state or version control', async () => {
    const { documents } = await scanArchive(await archive());
    const paths = documents.map((document) => document.path);

    expect(paths).not.toContain('.creative-archive/scratch/pending-x.md');
    expect(paths.some((path) => path.startsWith('.creative-archive'))).toBe(false);
    expect(paths.some((path) => path.startsWith('.git'))).toBe(false);
    expect(paths).toHaveLength(2);
  });

  it('falls back to the first heading, then the filename, for a title', async () => {
    const store = new MemoryFileStore();
    await store.write('a.md', '## Only heading\n\nbody\n');
    await store.write('b.md', 'no heading at all\n');

    const { documents } = await scanArchive(store);
    expect(documents.find((document) => document.path === 'a.md')?.title).toBe('Only heading');
    expect(documents.find((document) => document.path === 'b.md')?.title).toBe('b');
  });

  it('keeps a transcript searchable when its meta.yaml is corrupt', async () => {
    const store = new MemoryFileStore();
    await store.write('sessions/x/transcript.md', TRANSCRIPT);
    await store.write('sessions/x/meta.yaml', ': : not yaml : :\n\t- broken');

    const { documents } = await scanArchive(store);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.spans).toHaveLength(3);
    expect(documents[0]!.mode).toBeNull();
  });
});
