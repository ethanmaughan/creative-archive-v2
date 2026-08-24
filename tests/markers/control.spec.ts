import { describe, expect, it } from 'vitest';
import { parseLegend } from '../../src/core/markers/legend.ts';
import { matchControl } from '../../src/core/markers/control.ts';

const LEGEND_YAML = `- phrase: mark known error
  namespace: tag
  id: known-error
  span: forward
  writes: [transcript, error-index]
- phrase: end session
  namespace: control
  id: session-end
  safety: confirm
- phrase: abort
  namespace: control
  id: session-abort
  safety: confirm
- phrase: abort session
  namespace: control
  id: session-abort-alt
  safety: confirm
- phrase: footnote
  namespace: control
  id: footnote
  safety: safe
  captures: rest
- phrase: search for
  namespace: control
  id: search
  safety: safe
  captures: rest
`;

const legend = parseLegend(LEGEND_YAML, 'probe.yaml');

describe('Tier 0 control phrase matching', () => {
  it('matches a control phrase', () => {
    const match = matchControl('end session', legend);
    expect(match).not.toBeNull();
    expect(match!.entry.id).toBe('session-end');
    expect(match!.entry.safety).toBe('confirm');
    expect(match!.argument).toBe('');
  });

  it('captures rest of utterance when entry has captures: rest', () => {
    const match = matchControl('footnote this is important', legend);
    expect(match).not.toBeNull();
    expect(match!.entry.id).toBe('footnote');
    expect(match!.argument).toBe('this is important');
  });

  it('captures search query', () => {
    const match = matchControl('search for eigenvalues', legend);
    expect(match).not.toBeNull();
    expect(match!.entry.id).toBe('search');
    expect(match!.argument).toBe('eigenvalues');
  });

  it('does not match tag phrases', () => {
    expect(matchControl('mark known error', legend)).toBeNull();
  });

  it('does not match ordinary speech', () => {
    expect(matchControl('tell me about linear algebra', legend)).toBeNull();
  });

  it('returns empty argument when entry has no captures field', () => {
    const match = matchControl('end session and goodbye', legend);
    expect(match).not.toBeNull();
    expect(match!.entry.id).toBe('session-end');
    expect(match!.argument).toBe('');
  });

  it('prefers the longest phrase', () => {
    expect(matchControl('abort session', legend)!.entry.id).toBe('session-abort-alt');
    expect(matchControl('abort', legend)!.entry.id).toBe('session-abort');
  });

  it('is case-insensitive', () => {
    expect(matchControl('End Session', legend)!.entry.id).toBe('session-end');
    expect(matchControl('FOOTNOTE something', legend)!.entry.id).toBe('footnote');
  });

  it('returns null for empty input', () => {
    expect(matchControl('', legend)).toBeNull();
    expect(matchControl('   ', legend)).toBeNull();
  });

  it('returns null against an empty legend', () => {
    expect(matchControl('end session', { source: 'none', entries: [] })).toBeNull();
  });
});
