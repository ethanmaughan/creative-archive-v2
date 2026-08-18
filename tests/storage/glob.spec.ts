import { describe, expect, it } from 'vitest';
import { matchesAnyGlob, matchesGlob } from '../../src/core/storage/glob.ts';

describe('matchesGlob', () => {
  it('matches everything under ** ', () => {
    expect(matchesGlob('**', 'notes.md')).toBe(true);
    expect(matchesGlob('**', 'sessions/2026-08-18T1432Z-a7f3/transcript.md')).toBe(true);
  });

  it('grants a directory by granting its contents, not the directory entry itself', () => {
    expect(matchesGlob('sessions/**', 'sessions/abc/transcript.md')).toBe(true);
    expect(matchesGlob('sessions/**', 'sessions/abc')).toBe(true);
    expect(matchesGlob('sessions/**', 'sessions')).toBe(false);
  });

  it('does not let a sibling directory ride along on a prefix', () => {
    expect(matchesGlob('sessions/**', 'sessions-archive/abc.md')).toBe(false);
    expect(matchesGlob('ingest/**', 'ingested/thing.md')).toBe(false);
  });

  it('keeps a single star inside one segment', () => {
    expect(matchesGlob('notes/*.md', 'notes/idea.md')).toBe(true);
    expect(matchesGlob('notes/*.md', 'notes/deep/idea.md')).toBe(false);
  });

  it('lets **/ collapse to zero segments', () => {
    expect(matchesGlob('**/*.md', 'top.md')).toBe(true);
    expect(matchesGlob('**/*.md', 'a/b/c.md')).toBe(true);
    expect(matchesGlob('**/*.md', 'a/b/c.yaml')).toBe(false);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    expect(matchesGlob('notes/a.b.md', 'notes/a.b.md')).toBe(true);
    expect(matchesGlob('notes/a.b.md', 'notes/axbxmd')).toBe(false);
    expect(matchesGlob('notes/(draft).md', 'notes/(draft).md')).toBe(true);
  });

  it('matches against any pattern in a list', () => {
    expect(matchesAnyGlob(['sessions/**', 'notes/**'], 'notes/x.md')).toBe(true);
    expect(matchesAnyGlob(['sessions/**', 'notes/**'], 'ingest/x.md')).toBe(false);
    expect(matchesAnyGlob([], 'anything.md')).toBe(false);
  });
});
