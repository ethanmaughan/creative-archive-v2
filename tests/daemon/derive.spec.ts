import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/adapters/text/client.ts';
import { DaemonServer } from '../../src/core/daemon/server.ts';
import { SESSION_FILE, type DerivationReport } from '../../src/core/derive/derive.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import type { RetrievalResult } from '../../src/core/retrieval/retrieve.ts';
import { readMeta } from '../../src/core/session/meta.ts';
import { sessionDir } from '../../src/core/session/session-id.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

const DERIVED = {
  title: 'The repeating mission chapters',
  summary: 'Established that the missions repeat because each restates the stakes.',
  tags: ['novel', 'structure'],
  highlights: [{ turn: 2, why: 'the diagnosis' }],
  open_threads: [{ question: 'What does each mission cost the crew?', turn: 2 }],
};

describe('derivation over the wire', () => {
  let sandbox: Sandbox;
  let server: DaemonServer;
  let env: NodeJS.ProcessEnv;

  const start = async (): Promise<void> => {
    server = new DaemonServer({
      env,
      idleMs: 0,
      model: new ScriptedModelClient({ replies: ['Go on.'], derived: DERIVED }),
    });
    await server.listen();
  };

  /** Run a whole session and close it, returning its id. */
  const runSession = async (client: CoreClient, text: string): Promise<string> => {
    await client.request({ type: 'session.begin' });
    const said = await client.request<{ sessionId: string }>({ type: 'session.say', text });
    const end = await client.request<{ token: string }>({ type: 'session.end' });
    await client.request({ type: 'session.end.confirm', token: end.token });
    return said.sessionId;
  };

  const attach = async (): Promise<CoreClient> => {
    const client = await CoreClient.connect(server.path);
    await client.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'creative' });
    return client;
  };

  beforeEach(() => {
    sandbox = makeSandbox('ca2-derive-wire');
    env = {
      ...sandbox.env,
      CREATIVE_ARCHIVE_SOCKET: join(tmpdir(), `ca2d-${randomBytes(4).toString('hex')}.sock`),
    };
  });

  afterEach(async () => {
    await server.close();
    sandbox.cleanup();
  });

  it('derives the session that just closed, with no argument', async () => {
    await start();
    const client = await attach();
    const sessionId = await runSession(client, 'the mission chapters all read the same');

    const report = await client.request<DerivationReport>({ type: 'session.derive' });

    expect(report.outcome).toBe('derived');
    expect(report.sessionId).toBe(sessionId);
    expect(report.openThreads).toBe(1);

    const archive = await sandbox.open();
    const minutes = await archive.store.read(`${sessionDir(sessionId)}/${SESSION_FILE}`);
    expect(minutes).toContain('The repeating mission chapters');
    expect(minutes).toContain('What does each mission cost the crew?');
    expect((await readMeta(archive.store, sessionId)).tags).toEqual(['novel', 'structure']);

    client.close();
  });

  it('refuses to derive a session that is still open (§5.4)', async () => {
    await start();
    const client = await attach();
    await client.request({ type: 'session.begin' });
    const said = await client.request<{ sessionId: string }>({
      type: 'session.say',
      text: 'still talking',
    });

    await expect(
      client.request({ type: 'session.derive', sessionId: said.sessionId }),
    ).rejects.toThrow(/still open/);
    client.close();
  });

  it('says what to do when there is nothing to derive', async () => {
    await start();
    const client = await attach();
    await expect(client.request({ type: 'session.derive' })).rejects.toThrow(
      /end a session first/,
    );
    client.close();
  });

  it('derives a named earlier session', async () => {
    await start();
    const client = await attach();
    const first = await runSession(client, 'the first conversation about pacing');
    await runSession(client, 'a second, unrelated conversation');

    const report = await client.request<DerivationReport>({
      type: 'session.derive',
      sessionId: first,
    });
    expect(report.sessionId).toBe(first);
    client.close();
  });

  it('makes the derived title and tags searchable', async () => {
    await start();
    const client = await attach();
    await runSession(client, 'the mission chapters all read the same');
    await client.request({ type: 'session.derive' });

    // The index was stale after derivation; beginning the next session rebuilds it.
    await client.request({ type: 'session.begin' });
    const found = await client.request<RetrievalResult>({
      type: 'session.search',
      query: 'tag:structure',
    });

    expect(found.spans.length).toBeGreaterThan(0);
    expect(found.spans[0]!.title).toBe('The repeating mission chapters');
    client.close();
  });

  it('does not index the minutes themselves, only the transcript they came from', async () => {
    await start();
    const client = await attach();
    await runSession(client, 'the mission chapters all read the same');
    await client.request({ type: 'session.derive' });
    await client.request({ type: 'index.rebuild' });
    await client.request({ type: 'session.begin' });

    // "restates the stakes" appears only in the derived summary, never in the transcript.
    const derived = await client.request<RetrievalResult>({
      type: 'session.search',
      query: 'restates the stakes',
    });
    expect(derived.spans.every((span) => !span.deepLink.endsWith('session.md'))).toBe(true);

    // A model-written summary must never come back looking like something the user wrote.
    const all = await client.request<RetrievalResult>({
      type: 'session.search',
      query: 'mission',
    });
    expect(all.spans.every((span) => span.provenance === 'session')).toBe(true);
    client.close();
  });

  it('reports unparseable model output rather than writing rubbish', async () => {
    server = new DaemonServer({
      env,
      idleMs: 0,
      model: new ScriptedModelClient({ replies: ['Go on.'], derived: 'went well I think' }),
    });
    await server.listen();

    const client = await attach();
    const sessionId = await runSession(client, 'something worth minuting');
    const report = await client.request<DerivationReport>({ type: 'session.derive' });

    expect(report.outcome).toBe('unparseable');
    const archive = await sandbox.open();
    expect(await archive.store.exists(`${sessionDir(sessionId)}/${SESSION_FILE}`)).toBe(false);
    client.close();
  });
});
