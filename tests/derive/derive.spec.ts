import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_FILE, deriveSession } from '../../src/core/derive/derive.ts';
import { CoreError, ScopeViolation } from '../../src/core/errors.ts';
import { DEFAULT_IDENTITY } from '../../src/core/identity/identity.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { loadMode, type Mode } from '../../src/core/modes/mode.ts';
import { readMeta, writeMeta } from '../../src/core/session/meta.ts';
import { sessionDir } from '../../src/core/session/session-id.ts';
import { TRANSCRIPT_FILE, formatEntry } from '../../src/core/session/transcript.ts';
import { fixedClock, makeSandbox, type Sandbox } from '../helpers/sandbox.ts';
import type { Archive } from '../../src/core/archive/archive.ts';

const SESSION_ID = '2026-08-18T1432Z-a7f3';

const TURNS = [
  { at: '2026-08-18T14:32:00.000Z', role: 'agent' as const, text: "What's going on?" },
  {
    at: '2026-08-18T14:32:11.000Z',
    role: 'human' as const,
    text: 'The eigenvector sign keeps coming out negative.',
  },
  {
    at: '2026-08-18T14:32:20.000Z',
    role: 'agent' as const,
    text: 'Which pivot did you choose?',
  },
  {
    at: '2026-08-18T14:33:02.000Z',
    role: 'human' as const,
    text: 'The leftmost one, and I never checked whether it should have been negative.',
  },
];

const MODEL_OUTPUT = {
  title: 'Eigenvector sign',
  summary: 'Worked through a sign error in problem 4. Left unresolved.',
  tags: ['Linalg', '#eigenvectors', 'linalg'],
  outline: [{ heading: 'The sign error', turns: [2, 3] }],
  highlights: [{ turn: 4, why: 'the moment the actual gap surfaced' }],
  open_threads: [
    {
      question: 'Should the leftmost pivot have been negative?',
      why: 'never checked',
      turn: 4,
    },
  ],
};

async function seedSession(archive: Archive): Promise<void> {
  await archive.store.write(
    `${sessionDir(SESSION_ID)}/${TRANSCRIPT_FILE}`,
    TURNS.map((turn) => formatEntry(turn)).join(''),
  );
  await writeMeta(archive.store, {
    id: SESSION_ID,
    title: 'stuck on problem 4',
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

describe('the derivation pass (§5.4)', () => {
  let sandbox: Sandbox;
  let archive: Archive;
  let tutor: Mode;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-derive');
    archive = await sandbox.open();
    tutor = await loadMode('tutor');
    await seedSession(archive);
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  const derive = (options: { derived?: Record<string, unknown> | string; mode?: Mode } = {}) =>
    deriveSession({
      archive,
      sessionId: SESSION_ID,
      mode: options.mode ?? tutor,
      model: new ScriptedModelClient({ derived: options.derived ?? MODEL_OUTPUT }),
      now: fixedClock('2026-08-19T09:00:00.000Z'),
    });

  it('writes the minutes beside the transcript', async () => {
    const report = await derive();

    expect(report.outcome).toBe('derived');
    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);
    expect(written).toContain('# Eigenvector sign');
    expect(written).toContain('Left unresolved.');
    expect(written).toContain('Should the leftmost pivot have been negative?');
  });

  it('never touches the transcript (§7.1)', async () => {
    const path = `${sessionDir(SESSION_ID)}/${TRANSCRIPT_FILE}`;
    const before = await archive.store.read(path);
    await derive();
    expect(await archive.store.read(path)).toBe(before);
  });

  it('resolves cited turn numbers into links, rather than trusting a timestamp', async () => {
    await derive();
    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);

    // Turn 4 is the last human turn; its anchor is that turn's timestamp.
    expect(written).toContain('transcript.md#2026-08-18T14:33:02.000Z');
    expect(written).toContain('the moment the actual gap surfaced');
  });

  it('quotes a highlighted turn whole', async () => {
    await derive();
    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);
    expect(written).toContain('> The leftmost one, and I never checked whether it should have');
  });

  it('counts citations to turns that do not exist instead of dropping them quietly', async () => {
    const report = await derive({
      derived: {
        ...MODEL_OUTPUT,
        highlights: [{ turn: 99, why: 'nowhere' }],
        open_threads: [{ question: 'q', turn: 0 }],
        outline: [{ heading: 'ghost', turns: [42] }],
      },
    });

    expect(report.droppedReferences).toBe(3);
    expect(report.highlights).toBe(0);
  });

  it('enriches meta with tags, normalized and deduplicated', async () => {
    const report = await derive();
    const meta = await readMeta(archive.store, SESSION_ID);

    expect(meta.tags).toEqual(['linalg', 'eigenvectors']);
    expect(meta.derived_at).toBe('2026-08-19T09:00:00.000Z');
    expect(meta.derived_by).toBe('scripted');
    expect(report.tags).toEqual(['linalg', 'eigenvectors']);
  });

  it('takes the derived title, leaving the intake title only as a fallback', async () => {
    expect((await readMeta(archive.store, SESSION_ID)).title).toBe('stuck on problem 4');
    await derive();
    expect((await readMeta(archive.store, SESSION_ID)).title).toBe('Eigenvector sign');

    await derive({ derived: { summary: 'no title offered' } });
    expect((await readMeta(archive.store, SESSION_ID)).title).toBe('Eigenvector sign');
  });

  it('writes nothing when the model output cannot be parsed', async () => {
    const report = await derive({ derived: 'I think the session went well, honestly.' });

    expect(report.outcome).toBe('unparseable');
    expect(report.wrote).toEqual([]);
    expect(await archive.store.exists(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`)).toBe(false);
    // Absent is a state the system already handles: it is where every session starts.
    expect((await readMeta(archive.store, SESSION_ID)).derived_at).toBeNull();
  });

  it('is re-runnable, and replaces its own output', async () => {
    await derive();
    const first = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);

    await derive({
      derived: { ...MODEL_OUTPUT, summary: 'a better summary on second thought' },
    });
    const second = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);

    expect(second).not.toBe(first);
    expect(second).toContain('a better summary');
    expect(second).not.toContain('Left unresolved.');
  });

  it('handles a session with nothing in it', async () => {
    await archive.store.write(`${sessionDir(SESSION_ID)}/${TRANSCRIPT_FILE}`, '');
    const report = await derive();

    expect(report.outcome).toBe('empty-transcript');
    expect(report.wrote).toEqual([]);
  });

  it('refuses a session that does not exist', async () => {
    await expect(
      deriveSession({
        archive,
        sessionId: '2026-01-01T0000Z-ffff',
        mode: tutor,
        model: new ScriptedModelClient(),
      }),
    ).rejects.toThrow(CoreError);
  });

  it('respects the mode write scope (§3)', async () => {
    const walled: Mode = {
      ...tutor,
      id: 'walled',
      scope: { read: ['**'], write: ['notes/**'] },
    };
    await expect(derive({ mode: walled })).rejects.toThrow(ScopeViolation);
    expect(await archive.store.exists(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`)).toBe(false);
  });

  it('reports a template placeholder it has nothing for', async () => {
    const template: Mode = {
      ...tutor,
      sessionTemplatePath: new URL('./fixture-template.md', import.meta.url).pathname,
    };
    const report = await derive({ mode: template });
    expect(report.unresolvedPlaceholders).toEqual(['decisions']);

    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);
    // Left standing, so a template asking for something nobody produces is visible.
    expect(written).toContain('{{decisions}}');
    expect(written).toContain('Eigenvector sign');
  });

  it("keeps the template's own developer note out of the archive", async () => {
    await derive();
    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);

    // The comment at the top of a template is for whoever edits the template, not for the
    // person reading their minutes.
    expect(written).not.toContain('<!--');
    expect(written).not.toContain('§3, "output shape"');
    expect(written.startsWith('# Eigenvector sign')).toBe(true);
  });

  it('says so in the output when there is nothing to report', async () => {
    await derive({ derived: { summary: '', tags: [] } });
    const written = await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`);

    expect(written).toContain('Nothing was settled in this session.');
    expect(written).toContain('_None proposed._');
    expect(written).toContain('_Nothing left open._');
  });
});

describe('invariant 5, in full: derived output is personality-invariant (§4.4)', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox('ca2-derive-invariance');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('never puts the personality or the agent name in the derivation request', async () => {
    const archive = await sandbox.open();
    await seedSession(archive);

    const prompts: string[] = [];
    const model = {
      id: 'recording',
      async complete(request: { systemPrompt: string }): Promise<string> {
        prompts.push(request.systemPrompt);
        return JSON.stringify(MODEL_OUTPUT);
      },
    };

    await deriveSession({
      archive,
      sessionId: SESSION_ID,
      mode: await loadMode('tutor'),
      model,
      now: fixedClock(),
    });

    // The guarantee is structural: those strings are never in the request, so no amount of
    // model behaviour can leak them into the derived layer.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Alena');
    expect(prompts[0]).not.toContain('dry');
    expect(prompts[0]).not.toContain('wry');
  });

  it('produces byte-identical minutes under every preset', async () => {
    const outputs: string[] = [];

    for (const personality of ['plain', 'warm', 'dry', 'socratic', 'expansive'] as const) {
      sandbox.cleanup();
      sandbox = makeSandbox('ca2-derive-invariance');
      const archive = await sandbox.open();
      await seedSession(archive);
      await writeMeta(archive.store, {
        ...(await readMeta(archive.store, SESSION_ID)),
        personality,
        agent_name: `Agent ${personality}`,
      });

      await deriveSession({
        archive,
        sessionId: SESSION_ID,
        mode: await loadMode('tutor'),
        model: new ScriptedModelClient({ derived: MODEL_OUTPUT }),
        now: fixedClock(),
      });

      outputs.push(await archive.store.read(`${sessionDir(SESSION_ID)}/${SESSION_FILE}`));
    }

    for (const output of outputs) {
      expect(output).toBe(outputs[0]);
      expect(output).not.toContain('Agent ');
    }
  });

  it('leaves identity in metadata, where it is a fact about the session', async () => {
    const archive = await sandbox.open();
    await seedSession(archive);
    await deriveSession({
      archive,
      sessionId: SESSION_ID,
      mode: await loadMode('tutor'),
      model: new ScriptedModelClient({ derived: MODEL_OUTPUT }),
      now: fixedClock(),
    });

    const meta = await readMeta(archive.store, SESSION_ID);
    expect(meta.agent_name).toBe('Alena');
    expect(meta.personality).toBe('dry');
    expect(DEFAULT_IDENTITY.name).not.toBe(meta.agent_name);
  });
});
