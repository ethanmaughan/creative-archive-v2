import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigInvalid } from '../../src/core/errors.ts';
import {
  LEGEND_PATH,
  loadLegend,
  parseLegend,
  tagEntries,
  controlEntries,
} from '../../src/core/markers/legend.ts';
import { matchMarker } from '../../src/core/markers/match.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

const VALID_TAG = `- phrase: mark known error
  namespace: tag
  id: known-error
  span: forward
  writes: [transcript, error-index]
`;

const VALID_CONTROL = `- phrase: end session
  namespace: control
  id: session-end
  safety: confirm
`;

describe('the shipped legend', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox('ca2-legend');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('ships five tags and six control phrases', async () => {
    const archive = await sandbox.open();
    const legend = await loadLegend(archive.store);

    expect(tagEntries(legend).map((e) => e.id)).toEqual([
      'known-error',
      'confusion',
      'insight',
      'resolved',
      'revisit',
    ]);

    expect(controlEntries(legend).map((e) => e.id)).toEqual([
      'session-end',
      'session-end-alt',
      'session-abort',
      'session-abort-alt',
      'footnote',
      'search',
    ]);
  });

  it('leads every tag phrase with the particle that keeps ordinary speech out', async () => {
    const archive = await sandbox.open();
    const legend = await loadLegend(archive.store);

    for (const entry of tagEntries(legend)) {
      expect(entry.normalized.startsWith('mark ')).toBe(true);
    }
  });

  it("is overridden by the archive's own copy, because the vocabulary is the user's", async () => {
    const archive = await sandbox.open();
    await archive.store.write(
      LEGEND_PATH,
      `- phrase: mark this bit
  namespace: tag
  id: this-bit
  span: forward
  writes: [transcript]
`,
    );

    const legend = await loadLegend(archive.store);
    expect(legend.source).toBe(LEGEND_PATH);
    expect(legend.entries.map((entry) => entry.id)).toEqual(['this-bit']);
  });
});

describe('tag entry validation', () => {
  const bad =
    (yaml: string): (() => unknown) =>
    (): unknown =>
      parseLegend(yaml, 'probe.yaml');

  it('accepts a well-formed tag entry', () => {
    const legend = parseLegend(VALID_TAG, 'probe.yaml');
    const entry = legend.entries[0]!;
    expect(entry.namespace).toBe('tag');
    if (entry.namespace === 'tag') {
      expect(entry.writes).toEqual(['transcript', 'error-index']);
      expect(entry.span).toBe('forward');
    }
  });

  it('refuses paired spans by name', () => {
    expect(
      bad(`- phrase: mark start
  namespace: tag
  id: start
  span: paired
  writes: [transcript]
`),
    ).toThrow(/span 'paired' is not implemented yet/);
  });

  it('requires every marker to reach the append-only layer (§5.6)', () => {
    expect(
      bad(`- phrase: mark quietly
  namespace: tag
  id: quietly
  span: forward
  writes: [error-index]
`),
    ).toThrow(/must write to the transcript/);
  });

  it('refuses an unknown write target', () => {
    expect(
      bad(`- phrase: mark somewhere
  namespace: tag
  id: somewhere
  span: forward
  writes: [transcript, calendar]
`),
    ).toThrow(/unknown write target 'calendar'/);
  });

  it('refuses duplicate ids and duplicate phrases', () => {
    expect(bad(`${VALID_TAG}${VALID_TAG}`)).toThrow(/duplicate/);
    expect(
      bad(`${VALID_TAG}- phrase: Mark  Known   Error
  namespace: tag
  id: other
  span: forward
  writes: [transcript]
`),
    ).toThrow(/duplicate phrase/);
  });

  it('refuses an id that is not kebab-case, since it names a file-level concept', () => {
    expect(
      bad(`- phrase: mark thing
  namespace: tag
  id: Known_Error
  span: forward
  writes: [transcript]
`),
    ).toThrow(ConfigInvalid);
  });

  it('refuses a mapping where a list belongs', () => {
    expect(bad('phrase: mark known error\n')).toThrow(/expected a YAML list/);
  });

  it('refuses an unknown key rather than dropping it', () => {
    expect(
      bad(`- phrase: mark thing
  namespace: tag
  id: thing
  span: forward
  writes: [transcript]
  confirm: true
`),
    ).toThrow(ConfigInvalid);
  });
});

describe('control entry validation', () => {
  const bad =
    (yaml: string): (() => unknown) =>
    (): unknown =>
      parseLegend(yaml, 'probe.yaml');

  it('accepts a well-formed control entry with safety', () => {
    const legend = parseLegend(VALID_CONTROL, 'probe.yaml');
    const entry = legend.entries[0]!;
    expect(entry.namespace).toBe('control');
    if (entry.namespace === 'control') {
      expect(entry.safety).toBe('confirm');
    }
  });

  it('accepts captures: rest on control entries', () => {
    const legend = parseLegend(
      `- phrase: footnote
  namespace: control
  id: footnote
  safety: safe
  captures: rest
`,
      'probe.yaml',
    );
    const entry = legend.entries[0]!;
    expect(entry.namespace).toBe('control');
    if (entry.namespace === 'control') {
      expect(entry.captures).toBe('rest');
      expect(entry.safety).toBe('safe');
    }
  });

  it('refuses an unknown safety classification', () => {
    expect(
      bad(`- phrase: do thing
  namespace: control
  id: thing
  safety: yolo
`),
    ).toThrow(/unknown safety 'yolo'/);
  });

  it('refuses an unknown captures value', () => {
    expect(
      bad(`- phrase: do thing
  namespace: control
  id: thing
  safety: safe
  captures: first-word
`),
    ).toThrow(/unknown captures 'first-word'/);
  });

  it('refuses control entry with tag fields (span, writes)', () => {
    expect(
      bad(`- phrase: end session
  namespace: control
  id: session-end
  safety: confirm
  span: forward
`),
    ).toThrow(ConfigInvalid);
  });

  it('refuses tag entry with control fields (safety)', () => {
    expect(
      bad(`- phrase: mark thing
  namespace: tag
  id: thing
  span: forward
  writes: [transcript]
  safety: safe
`),
    ).toThrow(ConfigInvalid);
  });

  it('refuses phrases that duplicate across namespaces', () => {
    expect(
      bad(`- phrase: mark thing
  namespace: tag
  id: tag-thing
  span: forward
  writes: [transcript]
- phrase: mark thing
  namespace: control
  id: ctrl-thing
  safety: safe
`),
    ).toThrow(/duplicate phrase/);
  });
});

describe('matching a marker in something said', () => {
  const legend = parseLegend(
    `${VALID_TAG}- phrase: mark
  namespace: tag
  id: bare
  span: forward
  writes: [transcript]
`,
    'probe.yaml',
  );

  it('matches an exact phrase', () => {
    expect(matchMarker('mark known error', legend)?.entry.id).toBe('known-error');
  });

  it('is case and whitespace insensitive', () => {
    expect(matchMarker('  Mark   Known Error  ', legend)?.entry.id).toBe('known-error');
  });

  it("keeps what follows as the note, in the user's own words", () => {
    const match = matchMarker('mark known error: the Sign flip again', legend);
    expect(match?.entry.id).toBe('known-error');
    expect(match?.note).toBe('the Sign flip again');
  });

  it('accepts whatever punctuation introduces the note', () => {
    for (const said of [
      'mark known error: the sign flip',
      'mark known error — the sign flip',
      'mark known error, the sign flip',
      'mark known error. the sign flip',
      'mark  known   error the sign flip',
    ]) {
      const match = matchMarker(said, legend);
      expect(match?.entry.id, said).toBe('known-error');
      expect(match?.note, said).toBe('the sign flip');
    }
  });

  it('matches a phrase that ends the sentence', () => {
    expect(matchMarker('mark known error.', legend)?.entry.id).toBe('known-error');
    expect(matchMarker('mark known error!', legend)?.note).toBe('');
  });

  it('prefers the longest phrase, so a general marker cannot shadow a specific one', () => {
    expect(matchMarker('mark known error', legend)?.entry.id).toBe('known-error');
    expect(matchMarker('mark something else', legend)?.entry.id).toBe('bare');
  });

  it('leaves ordinary speech alone — the whole point of the particle', () => {
    expect(matchMarker("that's a known error in the compiler", legend)).toBeNull();
    expect(matchMarker('I keep making that known error', legend)).toBeNull();
    expect(matchMarker('remarkably, it worked', legend)).toBeNull();
  });

  it('does not fire on a phrase that merely starts the same word', () => {
    expect(matchMarker('marking the boundary', legend)).toBeNull();
  });

  it('returns nothing against an empty legend', () => {
    expect(matchMarker('mark known error', { source: 'none', entries: [] })).toBeNull();
  });

  it('filters by namespace when requested', () => {
    const mixed = parseLegend(`${VALID_TAG}${VALID_CONTROL}`, 'probe.yaml');
    expect(matchMarker('mark known error', mixed, 'tag')?.entry.id).toBe('known-error');
    expect(matchMarker('mark known error', mixed, 'control')).toBeNull();
    expect(matchMarker('end session', mixed, 'control')?.entry.id).toBe('session-end');
    expect(matchMarker('end session', mixed, 'tag')).toBeNull();
  });
});
