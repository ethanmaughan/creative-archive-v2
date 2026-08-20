import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERSONALITY_IDS, type PersonalityId } from '../../src/core/identity/personality.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { listModes, loadMode } from '../../src/core/modes/mode.ts';
import { readMeta } from '../../src/core/session/meta.ts';
import { Session } from '../../src/core/session/session.ts';
import { sessionDir } from '../../src/core/session/session-id.ts';
import { TRANSCRIPT_FILE } from '../../src/core/session/transcript.ts';
import { fixedClock, makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

/**
 * Invariant 5 (§4.4): personality never reaches the archive layer.
 *
 * Scope note. The spec asks for byte-identical *derived* output across presets, and the
 * derivation pass is step 3 — so the full form of this test cannot exist yet. What step 1
 * can prove is the part that is already real: given identical input, two presets produce
 * identical transcripts and identical metadata apart from the one field that records which
 * preset was in use. When derivation lands, this file gains the session.md comparison.
 *
 * The transcript is *not* personality-free in general — it records the agent's turns, and
 * a preset is precisely a change to how those turns read (D-004). The invariant that holds
 * is about the structure the archive is indexed by, not about the agent's wording, which is
 * why the model here is deliberately personality-blind.
 */
describe('invariant: personality does not reach the archive layer', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox('ca2-personality');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  const runSession = async (personality: PersonalityId) => {
    const archive = await sandbox.open();
    const session = await Session.begin({
      archive,
      identity: { name: 'Alena', personality },
      model: new ScriptedModelClient({ replies: ['Which step?', 'And after that?'] }),
      modes: await listModes(),
      mode: await loadMode('tutor'),
      now: fixedClock(),
    });

    await session.say('the eigenvector part of problem 4');
    await session.footnote('sign flip again');
    await session.say('I get a negative where the key has a positive');
    const request = session.requestEnd();
    await session.confirmEnd(request.token);

    const id = session.id!;
    return {
      id,
      transcript: await archive.store.read(`${sessionDir(id)}/${TRANSCRIPT_FILE}`),
      meta: await readMeta(archive.store, id),
      files: (await archive.store.list(sessionDir(id))).map((entry) =>
        entry.path.slice(sessionDir(id).length + 1),
      ),
    };
  };

  it('produces byte-identical transcripts under two presets', async () => {
    const plain = await runSession('plain');
    sandbox.cleanup();
    sandbox = makeSandbox('ca2-personality');
    const expansive = await runSession('expansive');

    expect(expansive.transcript).toBe(plain.transcript);
  });

  it('produces identical metadata apart from the recorded preset', async () => {
    const plain = await runSession('plain');
    sandbox.cleanup();
    sandbox = makeSandbox('ca2-personality');
    const dry = await runSession('dry');

    expect(dry.meta.personality).toBe('dry');
    expect(plain.meta.personality).toBe('plain');

    const { personality: _dropped, id: _dryId, ...dryRest } = dry.meta;
    const { personality: _alsoDropped, id: _plainId, ...plainRest } = plain.meta;
    expect(dryRest).toEqual(plainRest);
  });

  it('produces the same set of files in the session folder for every preset', async () => {
    const shapes: string[][] = [];
    for (const personality of PERSONALITY_IDS) {
      sandbox.cleanup();
      sandbox = makeSandbox('ca2-personality');
      shapes.push((await runSession(personality)).files);
    }
    for (const shape of shapes) {
      expect(shape).toEqual(shapes[0]);
    }
  });

  it('never writes the preset name into the transcript', async () => {
    for (const personality of PERSONALITY_IDS) {
      sandbox.cleanup();
      sandbox = makeSandbox('ca2-personality');
      const run = await runSession(personality);
      expect(run.transcript.toLowerCase(), personality).not.toContain(personality);
    }
  });

  it('keeps the agent name out of the transcript, in metadata only (§4.4)', async () => {
    const run = await runSession('warm');
    expect(run.meta.agent_name).toBe('Alena');
    expect(run.transcript).not.toContain('Alena');
  });
});
