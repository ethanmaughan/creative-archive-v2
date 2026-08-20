import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigInvalid } from '../../src/core/errors.ts';
import { LEGEND_PATH, loadLegend, parseLegend } from '../../src/core/markers/legend.ts';
import { matchMarker } from '../../src/core/markers/match.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

const VALID = `- phrase: mark known error
  namespace: tag
  id: known-error
  span: forward
  writes: [transcript, error-index]
`;

describe('the shipped legend', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox('ca2-legend');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('is the five tags §5.6 suggests starting with', async () => {
    const archive = await sandbox.open();
    const legend = await loadLegend(archive.store);

    expect(legend.entries.map((entry) => entry.id)).toEqual([
      'known-error',
      'confusion',
      'insight',
      'resolved',
      'revisit',
    ]);
  });

  it('leads every phrase with the particle that keeps ordinary speech out', async () => {
    const archive = await sandbox.open();
    const legend = await loadLegend(archive.store);

    for (const entry of legend.entries) {
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

describe('legend validation', () => {
  const bad =
    (yaml: string): (() => unknown) =>
    (): unknown =>
      parseLegend(yaml, 'probe.yaml');

  it('accepts a well-formed entry', () => {
    const legend = parseLegend(VALID, 'probe.yaml');
    expect(legend.entries[0]!.writes).toEqual(['transcript', 'error-index']);
    expect(legend.entries[0]!.span).toBe('forward');
  });

  it('refuses the control namespace by name, rather than recording what should act', () => {
    expect(
      bad(`- phrase: end the session
  namespace: control
  id: session-end
  span: forward
  writes: [transcript]
`),
    ).toThrow(/namespace 'control' is not implemented yet.*Tier 0/s);
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
    expect(bad(`${VALID}${VALID}`)).toThrow(/duplicate/);
    expect(
      bad(`${VALID}- phrase: Mark  Known   Error
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

describe('matching a marker in something said', () => {
  const legend = parseLegend(
    `${VALID}- phrase: mark
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
    // Requiring a literal space filed all of these under the shorter `mark` marker.
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
});
