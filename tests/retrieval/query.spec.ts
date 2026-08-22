import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, describeQuery, parseQuery } from '../../src/core/retrieval/query.ts';

describe('parseQuery', () => {
  it('separates free text from filters', () => {
    const query = parseQuery('eigenvector sign tag:linalg after:2026-01-01 in:session limit:3');
    expect(query.terms).toEqual(['eigenvector', 'sign']);
    expect(query.tags).toEqual(['linalg']);
    expect(query.after).toBe('2026-01-01');
    expect(query.provenance).toBe('session');
    expect(query.limit).toBe(3);
    expect(query.ignored).toEqual([]);
  });

  it('keeps a quoted filter value together', () => {
    const query = parseQuery('heading:"back substitution" pivots');
    expect(query.headings).toEqual(['back substitution']);
    expect(query.terms).toEqual(['pivots']);
  });

  it('widens a partial date so comparison stays lexical', () => {
    expect(parseQuery('after:2026').after).toBe('2026-01-01');
    expect(parseQuery('before:2026-03').before).toBe('2026-03-01');
  });

  it('surfaces an unrecognized key instead of dropping it silently', () => {
    const query = parseQuery('pivots kind:note author:me');
    expect(query.ignored).toEqual(['kind:note', 'author:me']);
    expect(query.terms).toEqual(['pivots']);
  });

  it('surfaces a whitelisted key with an unusable value', () => {
    expect(parseQuery('after:march').ignored).toEqual(['after:march']);
    expect(parseQuery('in:notebook').ignored).toEqual(['in:notebook']);
    expect(parseQuery('limit:0').ignored).toEqual(['limit:0']);
  });

  it('accepts ingest as a provenance now that ingested material exists', () => {
    expect(parseQuery('pivot in:ingest').provenance).toBe('ingest');
    expect(parseQuery('pivot in:ingest').ignored).toEqual([]);
  });

  it('clamps the limit and defaults it', () => {
    expect(parseQuery('anything').limit).toBe(DEFAULT_LIMIT);
    expect(parseQuery('limit:999').limit).toBe(50);
  });

  it('strips a leading hash from a tag so #tag and tag agree', () => {
    expect(parseQuery('tag:#linalg').tags).toEqual(['linalg']);
  });

  it('treats a bare colon-led word as text, not a filter', () => {
    expect(parseQuery(':oops').terms).toEqual(['oops']);
  });

  it('folds diacritics and drops one-character tokens', () => {
    expect(parseQuery('café a of').terms).toEqual(['cafe', 'of']);
  });
});

describe('describeQuery', () => {
  it('says what was actually asked for', () => {
    const description = describeQuery(parseQuery('pivots tag:linalg after:2026-01-01'));
    expect(description).toContain('terms [pivots]');
    expect(description).toContain('tags [linalg]');
    expect(description).toContain('after 2026-01-01');
  });

  it('says nothing was asked rather than pretending otherwise', () => {
    expect(describeQuery(parseQuery(''))).toBe('nothing');
  });
});
