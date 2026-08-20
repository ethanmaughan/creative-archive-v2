import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/adapters/text/client.ts';
import { DaemonServer } from '../../src/core/daemon/server.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { readMeta } from '../../src/core/session/meta.ts';
import { sessionDir } from '../../src/core/session/session-id.ts';
import { TRANSCRIPT_FILE, parseTranscript } from '../../src/core/session/transcript.ts';
import type { Event } from '../../src/protocol/messages.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

/**
 * End to end over the real socket: the text adapter driving the headless core (D-001).
 *
 * The client here is the same one `src/adapters/text/main.ts` uses, so anything provable
 * from a test is reachable by a person typing, with no microphone in the picture.
 */
describe('daemon + text adapter', () => {
  let sandbox: Sandbox;
  let server: DaemonServer;
  let env: NodeJS.ProcessEnv;

  const start = async (idleMs = 0): Promise<void> => {
    server = new DaemonServer({
      env,
      idleMs,
      model: new ScriptedModelClient({ replies: ['Which step did you get to?', 'And then?'] }),
    });
    await server.listen();
  };

  beforeEach(() => {
    sandbox = makeSandbox('ca2-daemon');
    // Short socket path: a unix socket path is capped near 104 bytes and the tmp archive
    // path is already long.
    env = {
      ...sandbox.env,
      CREATIVE_ARCHIVE_SOCKET: join(tmpdir(), `ca2-${randomBytes(4).toString('hex')}.sock`),
    };
  });

  afterEach(async () => {
    await server.close();
    sandbox.cleanup();
  });

  it('runs a whole session from attach to confirmed end', async () => {
    await start();
    const client = await CoreClient.connect(server.path);

    const attached = await client.request<{ archive: string; modes: string[]; model: string }>({
      type: 'attach',
      archive: sandbox.archiveRoot,
      mode: 'tutor',
    });
    expect(attached.archive).toBe(sandbox.archiveRoot);
    expect(attached.modes).toContain('tutor');
    expect(attached.model).toBe('scripted');

    const begun = await client.request<{ state: string; greeting: string }>({
      type: 'session.begin',
    });
    expect(begun.state).toBe('buffering');
    expect(begun.greeting).toMatch(/going on/);

    const said = await client.request<{ reply: string; committed: boolean; sessionId: string }>(
      {
        type: 'session.say',
        text: 'stuck on problem 4',
      },
    );
    expect(said.committed).toBe(true);
    expect(said.reply).toBe('Which step did you get to?');

    await client.request({ type: 'session.footnote', text: 'sign flip again' });

    const end = await client.request<{ token: string; question: string }>({
      type: 'session.end',
    });
    expect(end.question).toMatch(/End the session/);

    const meta = await client.request<{ id: string; ended_by: string }>({
      type: 'session.end.confirm',
      token: end.token,
    });
    expect(meta.ended_by).toBe('confirmed');

    const archive = await sandbox.open();
    const entries = parseTranscript(
      await archive.store.read(`${sessionDir(said.sessionId)}/${TRANSCRIPT_FILE}`),
    );
    expect(entries.map((entry) => entry.role)).toEqual(['agent', 'human', 'agent', 'footnote']);
    expect((await readMeta(archive.store, said.sessionId)).mode).toBe('tutor');

    client.close();
  });

  it('refuses a second session on the same archive', async () => {
    await start();
    const first = await CoreClient.connect(server.path);
    const second = await CoreClient.connect(server.path);

    for (const client of [first, second]) {
      await client.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });
    }

    await first.request({ type: 'session.begin' });
    await expect(second.request({ type: 'session.begin' })).rejects.toThrow(/already open/);

    first.close();
    second.close();
  });

  it('refuses a second session on a different archive too — there is one of you', async () => {
    // The limit is per person, not per archive. Two conversations at once about different
    // things is not something a human does, whichever archives they are in.
    const other = join(sandbox.dir, 'archive-two');
    mkdirSync(join(other, '.git'), { recursive: true });
    writeFileSync(
      join(sandbox.stateDir, 'archives.yaml'),
      `archives:\n  - ${sandbox.archiveRoot}\n  - ${other}\n`,
      'utf8',
    );

    await start();
    const first = await CoreClient.connect(server.path);
    const second = await CoreClient.connect(server.path);
    await first.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });
    await second.request({ type: 'attach', archive: other, mode: 'tutor' });

    await first.request({ type: 'session.begin' });
    await expect(second.request({ type: 'session.begin' })).rejects.toThrow(/one of you/);

    first.close();
    second.close();
  });

  it('frees the slot once the session ends, on any archive', async () => {
    await start();
    const first = await CoreClient.connect(server.path);
    await first.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });
    await first.request({ type: 'session.begin' });
    await first.request({ type: 'session.say', text: 'brief' });
    const end = await first.request<{ token: string }>({ type: 'session.end' });
    await first.request({ type: 'session.end.confirm', token: end.token });

    const second = await CoreClient.connect(server.path);
    await second.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });
    await expect(second.request({ type: 'session.begin' })).resolves.toBeDefined();

    first.close();
    second.close();
  });

  it('rejects requests before an archive is attached', async () => {
    await start();
    const client = await CoreClient.connect(server.path);
    await expect(client.request({ type: 'session.begin' })).rejects.toThrow(/attach/);
    client.close();
  });

  it('reports an archive that is not allowlisted instead of opening it (§6.0)', async () => {
    await start();
    const client = await CoreClient.connect(server.path);
    await expect(
      client.request({ type: 'attach', archive: join(sandbox.dir, 'not-an-archive') }),
    ).rejects.toThrow(/not a directory|not an allowed archive/);
    client.close();
  });

  it('persists identity per archive across connections (D-003)', async () => {
    await start();
    const first = await CoreClient.connect(server.path);
    await first.request({ type: 'attach', archive: sandbox.archiveRoot });
    await first.request({ type: 'identity.set', name: 'Alena', personality: 'dry' });
    first.close();

    const second = await CoreClient.connect(server.path);
    const attached = await second.request<{ identity: { name: string; personality: string } }>({
      type: 'attach',
      archive: sandbox.archiveRoot,
    });
    expect(attached.identity).toEqual({ name: 'Alena', personality: 'dry' });
    second.close();
  });

  it('prompts to confirm on idle rather than closing the session (§5.3)', async () => {
    await start(40);
    const client = await CoreClient.connect(server.path);

    const events: Event[] = [];
    client.onEvent((event) => events.push(event));

    await client.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });
    await client.request({ type: 'session.begin' });
    await client.request({ type: 'session.say', text: 'thinking about this' });

    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(events).toHaveLength(1);
    expect(events[0]!.payload.reason).toBe('idle');
    expect(events[0]!.payload.question).toMatch(/Still there/);

    // The session is still open until the token comes back — the timer never closes it.
    const status = await client.request<{ state: string }>({ type: 'session.status' });
    expect(status.state).toBe('ending');

    const meta = await client.request<{ ended_by: string }>({
      type: 'session.end.confirm',
      token: events[0]!.payload.token,
    });
    expect(meta.ended_by).toBe('idle');

    client.close();
  });

  it('surfaces a malformed request without dropping the connection', async () => {
    await start();
    const client = await CoreClient.connect(server.path);
    await client.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });

    await expect(
      client.request({ type: 'session.say' } as unknown as { type: 'session.status' }),
    ).rejects.toThrow();

    // Still usable.
    await expect(client.request({ type: 'session.status' })).resolves.toBeDefined();
    client.close();
  });

  it('cleans up its socket on close', async () => {
    await start();
    expect(existsSync(server.path)).toBe(true);
    await server.close();
    expect(existsSync(server.path)).toBe(false);
    await start();
  });
});
