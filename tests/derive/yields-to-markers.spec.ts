import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Archive } from '../../src/core/archive/archive.ts';
import { SESSION_FILE, deriveSession } from '../../src/core/derive/derive.ts';
import { numberTranscript } from '../../src/core/derive/prompt.ts';
import { loadLegend, parseLegend, type Legend } from '../../src/core/markers/legend.ts';
import { indexedSpans, markedSpans, markedTurns } from '../../src/core/markers/spans.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { loadMode, type Mode } from '../../src/core/modes/mode.ts';
import { writeMeta } from '../../src/core/session/meta.ts';
import { sessionDir } from '../../src/core/session/session-id.ts';
import { formatEntry, TRANSCRIPT_FILE } from '../../src/core/session/transcript.ts';
import { fixedClock, makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

const SESSION_ID = '2026-08-18T1432Z-a7f3';

/**
 * Turn 1 agent, 2 human, 3 marker(known-error) covering 4, 5 human, 6 marker(insight)
 * covering 7.
 *
 * `known-error` writes to the error index; `insight` does not. Both are marked ground, so
 * derivation yields for both — only the first contributes a thread.
 */
const TURNS = [
  { at: '2026-08-18T14:32:00.000Z', role: 'agent' as const, text: "What's going on?" },
  { at: '2026-08-18T14:32:11.000Z', role: 'human' as const, text: 'The sign keeps flipping.' },
  {
    at: '2026-08-18T14:32:30.000Z',
    role: 'marker' as const,
    text: 'the pivot choice, again',
    markerId: 'known-error',
  },
  {
    at: '2026-08-18T14:32:40.000Z',
    role: 'human' as const,
    text: 'I picked the leftmost pivot without checking it.',
  },
  { at: '2026-08-18T14:33:00.000Z', role: 'human' as const, text: 'Then I moved on.' },
  { at: '2026-08-18T14:33:20.000Z', role: 'marker' as const, text: '', markerId: 'insight' },
  {
    at: '2026-08-18T14:33:30.000Z',
    role: 'human' as const,
    text: 'The sign is a property of the ordering, not the vector.',
  },
];

async function seed(archive: Archive): Promise<void> {
  await archive.store.write(
    `${sessionDir(SESSION_ID)}/${TRANSCRIPT_FILE}`,
    TURNS.map((turn) => formatEntry(turn)).join(''),
  );
  await writeMeta(archive.store, {
    id: SESSION_ID,
    title: 'sign flips',
    mode: 'tutor',
    agent_name: 'Alena',
    personality: 'dry',
    started_at: '2026-08-18T14:32:00.000Z',
    committed_at: '2026-08-18T14:32:05.000Z',
    ended_at: '2026-08-18T14:40:00.000Z',
    ended_by: 'confirmed',
    recovered: false,
    links: [],
    tags: [],
    derived_at: null,
    derived_by: null,
  });
}

describe('marker spans (§5.6)', () => {
  const legend = parseLegend(
    `- phrase: mark known error
  namespace: tag
  id: known-error
  span: forward
  writes: [transcript, error-index]
- phrase: mark insight
  namespace: tag
  id: insight
  span: forward
  writes: [transcript]
`,
    'probe',
  );

  it('scopes forward to the next thing said', () => {
    const spans = markedSpans(TURNS, legend);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ markerTurn: 3, coversTurn: 4, markerId: 'known-error' });
    expect(spans[1]).toMatchObject({ markerTurn: 6, coversTurn: 7, markerId: 'insight' });
  });

  it('treats two markers in a row as two annotations on the same passage', () => {
    const doubled = [
      TURNS[0]!,
      { at: 'x', role: 'marker' as const, text: '', markerId: 'known-error' },
      { at: 'y', role: 'marker' as const, text: '', markerId: 'insight' },
      TURNS[1]!,
    ];
    const spans = markedSpans(doubled, legend);
    expect(spans.map((span) => span.coversTurn)).toEqual([4, 4]);
  });

  it('leaves a trailing marker covering nothing rather than inventing a span', () => {
    const trailing = [
      TURNS[0]!,
      { at: 'z', role: 'marker' as const, text: '', markerId: 'insight' },
    ];
    expect(markedSpans(trailing, legend)[0]!.coversTurn).toBeNull();
  });

  it('counts the marker row and what it covers as marked ground', () => {
    expect([...markedTurns(markedSpans(TURNS, legend))].sort()).toEqual([3, 4, 6, 7]);
  });

  it('routes to the error index only what the legend says routes there', () => {
    const indexed = indexedSpans(markedSpans(TURNS, legend));
    expect(indexed.map((span) => span.markerId)).toEqual(['known-error']);
  });

  it('shows the model which marker fired', () => {
    expect(numberTranscript(TURNS)).toContain(
      '[3] marker:known-error: the pivot choice, again',
    );
  });
});

describe('invariant 6: derivation yields to markers but still runs everywhere', () => {
  let sandbox: Sandbox;
  let archive: Archive;
  let tutor: Mode;
  let legend: Legend;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-yield');
    archive = await sandbox.open();
    tutor = await loadMode('tutor');
    legend = await loadLegend(archive.store);
    await seed(archive);
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  const derive = (derived: Record<string, unknown>, withLegend = true) =>
    deriveSession({
      archive,
      sessionId: SESSION_ID,
      mode: tutor,
      model: new ScriptedModelClient({ derived }),
      ...(withLegend ? { legend } : {}),
      now: fixedClock(),
    });

  it('discards derived output for a turn a marker speaks for', async () => {
    const report = await derive({
      summary: 'a session',
      // Turns 3, 4, 6 and 7 are marked ground; 2 and 5 are not.
      open_threads: [
        { question: 'about the pivot', turn: 4 },
        { question: 'about moving on', turn: 5 },
      ],
      highlights: [
        { turn: 7, why: 'the realization' },
        { turn: 2, why: 'the symptom' },
      ],
    });

    expect(report.yieldedToMarkers).toBe(2);
    expect(report.highlights).toBe(1);

    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);
    expect(written).toContain('about moving on');
    expect(written).not.toContain('about the pivot');
    expect(written).toContain('the symptom');
    expect(written).not.toContain('the realization');
  });

  it('still runs over the unmarked stretches — that half is the point', async () => {
    const report = await derive({
      summary: 'the pass still described what was not marked',
      open_threads: [{ question: 'why did we move on', turn: 5 }],
    });

    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);
    expect(written).toContain('the pass still described what was not marked');
    expect(written).toContain('why did we move on');
    expect(report.yieldedToMarkers).toBe(0);
  });

  it('contributes a thread from a marker the legend routes to the error index', async () => {
    const report = await derive({ summary: '' });

    expect(report.markerThreads).toBe(1);
    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);
    // The marker's own note, not a restatement of it.
    expect(written).toContain('**known-error**: the pivot choice, again');
    // `insight` writes only to the transcript, so it annotates without filing a thread.
    expect(written).not.toContain('**insight**');
  });

  it('shows ground truth and proposals as different kinds of claim (§5.4)', async () => {
    await derive({
      summary: 'x',
      open_threads: [{ question: 'a guess about the ending', turn: 5 }],
    });

    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);
    const lines = written.split('\n');

    const proposal = lines.find((line) => line.includes('a guess about the ending'))!;
    expect(proposal).toMatch(/_\(proposed\)_$/);

    const fromMarker = lines.find((line) => line.includes('**known-error**'))!;
    expect(fromMarker).not.toContain('_(proposed)_');

    // Markers come first: what you said outranks what the pass guessed.
    const markerAt = written.indexOf('**known-error**');
    expect(markerAt).toBeGreaterThan(-1);
    expect(markerAt).toBeLessThan(written.indexOf('a guess about the ending'));
  });

  it('falls back to the covered turn when a marker carries no note', async () => {
    const custom = parseLegend(
      `- phrase: mark insight
  namespace: tag
  id: insight
  span: forward
  writes: [transcript, error-index]
`,
      'probe',
    );
    await deriveSession({
      archive,
      sessionId: SESSION_ID,
      mode: tutor,
      model: new ScriptedModelClient({ derived: { summary: '' } }),
      legend: custom,
      now: fixedClock(),
    });

    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);
    expect(written).toContain('**insight**: The sign is a property of the ordering');
  });

  it('yields to markers even with no legend, but files no threads from them', async () => {
    const report = await derive(
      { summary: 'x', highlights: [{ turn: 4, why: 'marked ground' }] },
      false,
    );

    // The marker rows are in the transcript either way, so the ground is still covered.
    expect(report.yieldedToMarkers).toBe(1);
    // Without the legend there is no way to know what routes to the error index.
    expect(report.markerThreads).toBe(0);
  });
});
