import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IDENTITY } from '../../src/core/identity/identity.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { listModes, loadMode, type Mode } from '../../src/core/modes/mode.ts';
import { readMeta } from '../../src/core/session/meta.ts';
import { OPEN_SESSION_PATH, readOpenSession } from '../../src/core/session/open-session.ts';
import { GREETING, SCRATCH_DIR, Session } from '../../src/core/session/session.ts';
import { parseTranscript } from '../../src/core/session/transcript.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

describe('session lifecycle (§5)', () => {
  let sandbox: Sandbox;
  let modes: Mode[];
  let tutor: Mode;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-session');
    modes = await listModes();
    tutor = await loadMode('tutor');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  const begin = async (options: { mode?: Mode; model?: ScriptedModelClient } = {}) => {
    const archive = await sandbox.open();
    const model = options.model ?? new ScriptedModelClient({ replies: ['Which chapter?'] });
    const session = await Session.begin({
      archive,
      identity: DEFAULT_IDENTITY,
      model,
      modes,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
    });
    return { archive, model, session };
  };

  it('buffers from the first word, before any folder exists (§5.1 step 1)', async () => {
    const { archive, session } = await begin();

    expect(session.state).toBe('buffering');
    expect(session.id).toBeNull();
    expect(await archive.store.exists('sessions')).toBe(false);

    const buffered = await archive.store.read(session.transcriptPath);
    expect(buffered).toContain(GREETING);
  });

  it('carries the preamble into the committed transcript byte-for-byte', async () => {
    const { archive, session } = await begin({ mode: tutor });
    const preamble = "I've been staring at the Act II mission chapters for two hours";

    const buffered = await archive.store.read(session.transcriptPath);
    const result = await session.say(preamble);

    expect(result.committed).toBe(true);
    expect(session.state).toBe('open');
    expect(session.id).not.toBeNull();

    // The buffer was renamed into place, so its bytes are the head of the transcript.
    const transcript = await archive.store.read(session.transcriptPath);
    expect(transcript.startsWith(buffered)).toBe(true);
    expect(transcript).toContain(preamble);
    expect(await archive.store.exists(SCRATCH_DIR)).toBe(true);
    expect(await archive.store.list(SCRATCH_DIR)).toEqual([]);
  });

  it('asks for the mode only when the utterance does not carry one (§5.1 step 4)', async () => {
    const { session } = await begin();

    const first = await session.say('everything is broken and I hate it');
    expect(first.committed).toBe(false);
    expect(first.reply).toMatch(/Which mode/);
    expect(session.state).toBe('buffering');

    const second = await session.say('tutor');
    expect(second.committed).toBe(true);
    expect(session.mode?.id).toBe('tutor');
  });

  it('takes the mode from intake when the model extracts one', async () => {
    const model = new ScriptedModelClient({
      replies: ['Which part of it?'],
      intent: { mode: 'creative', title: 'Act II mission chapters' },
    });
    const { archive, session } = await begin({ model });

    await session.say("I'm stuck on the Act II mission chapters");

    expect(session.mode?.id).toBe('creative');
    expect(session.title).toBe('Act II mission chapters');
    const meta = await readMeta(archive.store, session.id!);
    expect(meta.title).toBe('Act II mission chapters');
    expect(meta.mode).toBe('creative');
  });

  it('discards the buffer when the user aborts before commit (§5.1)', async () => {
    const { archive, session } = await begin();
    const path = session.transcriptPath;

    await session.abort();

    expect(session.state).toBe('aborted');
    expect(await archive.store.exists(path)).toBe(false);
    expect(await archive.store.list(SCRATCH_DIR)).toEqual([]);
  });

  it('records both sides of the conversation (D-004)', async () => {
    const model = new ScriptedModelClient({ replies: ['Name the step you got to.'] });
    const { archive, session } = await begin({ mode: tutor, model });

    await session.say('I cannot get the eigenvector part');

    const entries = parseTranscript(await archive.store.read(session.transcriptPath));
    expect(entries.map((entry) => entry.role)).toEqual(['agent', 'human', 'agent']);
    expect(entries[1]!.text).toBe('I cannot get the eigenvector part');
    expect(entries[2]!.text).toBe('Name the step you got to.');
  });

  it('writes an explicit footnote into the transcript at its timestamp (§5.2)', async () => {
    const { archive, session } = await begin({ mode: tutor });
    await session.say('starting on problem 4');

    await session.footnote('the sign flip is the part I never get right');

    const entries = parseTranscript(await archive.store.read(session.transcriptPath));
    const footnote = entries.find((entry) => entry.role === 'footnote');
    expect(footnote?.text).toBe('the sign flip is the part I never get right');
  });

  it('refuses a footnote before the session has committed', async () => {
    const { session } = await begin({ mode: tutor });
    await expect(session.footnote('too early')).rejects.toThrow(/committed session/);
  });

  it('always confirms an end, and only with the matching token (§5.3)', async () => {
    const { archive, session } = await begin({ mode: tutor });
    await session.say('lets go');

    const request = session.requestEnd();
    expect(session.state).toBe('ending');
    expect(request.question).toMatch(/End the session/);

    await expect(session.confirmEnd('not-the-token')).rejects.toThrow(/does not match/);
    expect(session.state).toBe('ending');

    const meta = await session.confirmEnd(request.token);
    expect(session.state).toBe('closed');
    expect(meta.ended_by).toBe('confirmed');
    expect(meta.ended_at).not.toBeNull();
    expect(await archive.store.exists(OPEN_SESSION_PATH)).toBe(false);
  });

  it('phrases the idle end differently but still confirms it', async () => {
    const { session } = await begin({ mode: tutor });
    await session.say('thinking');

    const request = session.requestEnd('idle');
    expect(request.question).toMatch(/Still there/);
    const meta = await session.confirmEnd(request.token);
    expect(meta.ended_by).toBe('idle');
  });

  it('can cancel an end and keep going', async () => {
    const { session } = await begin({ mode: tutor });
    await session.say('lets go');

    session.requestEnd();
    session.cancelEnd();

    expect(session.state).toBe('open');
    await expect(session.say('still here')).resolves.toBeDefined();
  });

  it('marks the archive as having an open session until it closes cleanly', async () => {
    const { archive, session } = await begin({ mode: tutor });
    await session.say('lets go');

    const pointer = await readOpenSession(archive.store);
    expect(pointer?.session_id).toBe(session.id);

    const request = session.requestEnd();
    await session.confirmEnd(request.token);
    expect(await readOpenSession(archive.store)).toBeNull();
  });

  it('uses an immutable timestamp id and keeps the title in metadata (§7)', async () => {
    const { archive, session } = await begin({ mode: tutor });
    await session.say('the Act II mission chapters keep repeating');

    expect(session.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{4}Z-[0-9a-f]{4}$/);
    const meta = await readMeta(archive.store, session.id!);
    expect(meta.title).toContain('Act II');
    expect(session.id).not.toContain('Act');
  });
});
