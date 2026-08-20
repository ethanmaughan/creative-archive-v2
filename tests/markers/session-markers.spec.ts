import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IDENTITY } from '../../src/core/identity/identity.ts';
import { loadLegend, parseLegend, type Legend } from '../../src/core/markers/legend.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { listModes, loadMode, type Mode } from '../../src/core/modes/mode.ts';
import { Session } from '../../src/core/session/session.ts';
import { parseTranscript } from '../../src/core/session/transcript.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

describe('markers during a session (§5.6)', () => {
  let sandbox: Sandbox;
  let modes: Mode[];
  let tutor: Mode;
  let legend: Legend;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-session-markers');
    modes = await listModes();
    tutor = await loadMode('tutor');
    legend = await loadLegend((await sandbox.open()).store);
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  const begin = async (options: { legend?: Legend; mode?: Mode } = {}) => {
    const archive = await sandbox.open();
    const model = new ScriptedModelClient({ replies: ['Which step?', 'And then?'] });
    const session = await Session.begin({
      archive,
      identity: DEFAULT_IDENTITY,
      model,
      modes,
      mode: options.mode ?? tutor,
      ...(options.legend === undefined ? { legend } : { legend: options.legend }),
    });
    return { archive, model, session };
  };

  it('records a marker without answering it — markers fire silently', async () => {
    const { archive, model, session } = await begin();
    await session.say('working on problem 4');
    const callsBefore = model.callCount;

    const result = await session.say('mark known error');

    expect(result.marker).toEqual({ id: 'known-error', note: '' });
    expect(result.reply).toBe('');
    // No model call: a marker is not something said to the agent.
    expect(model.callCount).toBe(callsBefore);

    const entries = parseTranscript(await archive.store.read(session.transcriptPath));
    const marker = entries.find((entry) => entry.role === 'marker');
    expect(marker?.markerId).toBe('known-error');
  });

  it('puts the marker in the append-only layer, in order', async () => {
    const { archive, session } = await begin();
    await session.say('the eigenvector sign is wrong');
    await session.say('mark known error the sign flip');
    await session.say('I never checked the pivot');

    const entries = parseTranscript(await archive.store.read(session.transcriptPath));
    expect(entries.map((entry) => entry.role)).toEqual([
      'agent',
      'human',
      'agent',
      'marker',
      'human',
      'agent',
    ]);
    expect(entries[3]!.text).toBe('the sign flip');
  });

  it('scopes forward: the marker sits immediately before what it marks', async () => {
    const { archive, session } = await begin();
    await session.say('starting');
    await session.say('mark confusion');
    await session.say('this is the part I do not follow');

    const entries = parseTranscript(await archive.store.read(session.transcriptPath));
    const markerAt = entries.findIndex((entry) => entry.role === 'marker');

    // Because a marker produces no agent turn, the next entry is the user's own next
    // utterance — which is the thing being marked, not a reply that happened in between.
    expect(entries[markerAt + 1]!.role).toBe('human');
    expect(entries[markerAt + 1]!.text).toBe('this is the part I do not follow');
  });

  it('treats ordinary speech as ordinary speech', async () => {
    const { archive, model, session } = await begin();
    await session.say('starting');
    const callsBefore = model.callCount;

    const result = await session.say("that's a known error in the compiler");

    expect(result.marker).toBeUndefined();
    expect(result.reply).not.toBe('');
    expect(model.callCount).toBeGreaterThan(callsBefore);

    const entries = parseTranscript(await archive.store.read(session.transcriptPath));
    expect(entries.some((entry) => entry.role === 'marker')).toBe(false);
  });

  it('does not fire before the session has committed', async () => {
    const { archive, session } = await begin();

    // Intake has not resolved a mode yet, so there is no `mark` tool to grant. The phrase is
    // recorded as what it literally is: something the user said.
    const result = await session.say('mark known error');

    expect(result.marker).toBeUndefined();
    const entries = parseTranscript(await archive.store.read(session.transcriptPath));
    expect(entries.some((entry) => entry.role === 'marker')).toBe(false);
  });

  it('does not fire in a mode that does not grant the tool (§3)', async () => {
    const toolless: Mode = { ...tutor, id: 'toolless', tools: ['footnote', 'session_end'] };
    const { session } = await begin({ mode: toolless });
    await session.say('starting');

    const result = await session.say('mark known error');
    expect(result.marker).toBeUndefined();
    expect(result.reply).not.toBe('');
  });

  it('does not fire when the archive has no legend', async () => {
    const { session } = await begin({ legend: { source: 'none', entries: [] } });
    await session.say('starting');

    const result = await session.say('mark known error');
    expect(result.marker).toBeUndefined();
  });

  it('uses the archive own vocabulary when it has one', async () => {
    const custom = parseLegend(
      `- phrase: mark this bit
  namespace: tag
  id: this-bit
  span: forward
  writes: [transcript]
`,
      'custom',
    );
    const { archive, session } = await begin({ legend: custom });
    await session.say('starting');

    expect((await session.say('mark this bit')).marker?.id).toBe('this-bit');
    // The shipped vocabulary is not silently also in force.
    expect((await session.say('mark known error')).marker).toBeUndefined();

    const entries = parseTranscript(await archive.store.read(session.transcriptPath));
    expect(entries.filter((entry) => entry.role === 'marker')).toHaveLength(1);
  });

  it('leaves no stray blank paragraph when a marker carries no note', async () => {
    const { archive, session } = await begin();
    await session.say('starting');
    await session.say('mark revisit');
    await session.say('the next thing');

    const raw = await archive.store.read(session.transcriptPath);
    // Permanent in ground truth, so worth getting right rather than tidying later.
    expect(raw).not.toMatch(/\n\n\n/);
    expect(raw).toContain('marker:revisit\n\n## ');
    expect(parseTranscript(raw).find((entry) => entry.role === 'marker')?.text).toBe('');
  });

  it('survives a round trip through the transcript format', async () => {
    const { archive, session } = await begin();
    await session.say('starting');
    await session.say('mark insight the stakes are the problem, not the missions');

    const raw = await archive.store.read(session.transcriptPath);
    expect(raw).toContain('marker:insight');

    const entries = parseTranscript(raw);
    const marker = entries.find((entry) => entry.role === 'marker')!;
    expect(marker.markerId).toBe('insight');
    expect(marker.text).toBe('the stakes are the problem, not the missions');
  });
});
