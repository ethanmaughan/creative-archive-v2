import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/adapters/text/client.ts';
import { DaemonServer } from '../../src/core/daemon/server.ts';
import { DEFAULT_IDENTITY } from '../../src/core/identity/identity.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { listModes, loadMode } from '../../src/core/modes/mode.ts';
import { readMeta } from '../../src/core/session/meta.ts';
import { readOpenSession } from '../../src/core/session/open-session.ts';
import { recoverArchive } from '../../src/core/session/recovery.ts';
import { Session } from '../../src/core/session/session.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

/** How many descriptors this process currently holds. Linux exposes /proc, macOS /dev/fd. */
function openDescriptors(): number {
  for (const path of ['/proc/self/fd', '/dev/fd']) {
    try {
      return readdirSync(path).length;
    } catch {
      continue;
    }
  }
  throw new Error('cannot count open file descriptors on this platform');
}

/**
 * Regressions for two bugs found by running the adapter by hand.
 *
 * 1. A client that goes away mid-session left its transcript's file descriptor open. Nothing
 *    releases an openSync fd on garbage collection, so the daemon leaked one per dropped
 *    client until it ran out.
 * 2. `/abort` on a committed session was refused by the core and the client quit anyway,
 *    abandoning the session it had just been told it could not throw away.
 */
describe('an abandoned session releases its file handle', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox('ca2-abandon');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('closes the transcript without touching what is on disk', async () => {
    const archive = await sandbox.open();
    const session = await Session.begin({
      archive,
      identity: DEFAULT_IDENTITY,
      model: new ScriptedModelClient(),
      modes: await listModes(),
      mode: await loadMode('tutor'),
    });
    await session.say('half a thought');

    const before = await archive.store.read(session.transcriptPath);
    session.abandon();

    expect(await archive.store.read(session.transcriptPath)).toBe(before);
    // The pointer stays: recovery is what closes the books, as a crash (§5.3).
    expect(await readOpenSession(archive.store)).not.toBeNull();
  });

  it('is safe to call twice', async () => {
    const archive = await sandbox.open();
    const session = await Session.begin({
      archive,
      identity: DEFAULT_IDENTITY,
      model: new ScriptedModelClient(),
      modes: await listModes(),
      mode: await loadMode('tutor'),
    });

    session.abandon();
    expect(() => session.abandon()).not.toThrow();
  });
});

describe('a dropped client does not strand a session', () => {
  let sandbox: Sandbox;
  let server: DaemonServer;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-dropped');
    env = {
      ...sandbox.env,
      CREATIVE_ARCHIVE_SOCKET: join(tmpdir(), `ca2a-${randomBytes(4).toString('hex')}.sock`),
    };
    server = new DaemonServer({ env, idleMs: 0, model: new ScriptedModelClient() });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    sandbox.cleanup();
  });

  const connect = async (): Promise<CoreClient> => {
    const client = await CoreClient.connect(server.path);
    await client.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });
    return client;
  };

  it('lets a new client open a session after the previous one vanished', async () => {
    const first = await connect();
    await first.request({ type: 'session.begin' });
    await first.request({ type: 'session.say', text: 'dropped mid-thought' });
    first.close();

    // Give the server its close event.
    await new Promise((resolve) => setTimeout(resolve, 60));

    const second = await connect();
    await expect(second.request({ type: 'session.begin' })).resolves.toBeDefined();
    second.close();
  });

  it('does not accumulate file descriptors across dropped clients', async () => {
    // Counting descriptors rather than waiting to exhaust them: the limit is in the
    // thousands, so a test that only ran sessions and asserted "still works" would pass
    // whether or not the leak existed.
    const before = openDescriptors();

    for (let round = 0; round < 12; round += 1) {
      const client = await connect();
      await client.request({ type: 'session.begin' });
      await client.request({ type: 'session.say', text: `round ${round}` });
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const after = openDescriptors();
    // Sockets and transcripts both used to be held. A few descriptors of slack absorbs
    // unrelated runtime churn; 12 leaked transcripts would sail past it.
    expect(after - before).toBeLessThan(6);
  });

  it('records an abandoned session as a crash on the next launch (§5.3)', async () => {
    const client = await connect();
    await client.request({ type: 'session.begin' });
    const said = await client.request<{ sessionId: string }>({
      type: 'session.say',
      text: 'left without ending',
    });
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 60));

    const archive = await sandbox.open();
    const report = await recoverArchive(archive, { identity: DEFAULT_IDENTITY });

    expect(report.crashedSessions).toEqual([said.sessionId]);
    const meta = await readMeta(archive.store, said.sessionId);
    expect(meta.ended_by).toBe('crash');
    expect(meta.recovered).toBe(true);
  });
});

describe('a refused abort leaves the session alone', () => {
  let sandbox: Sandbox;
  let server: DaemonServer;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-refused-abort');
    env = {
      ...sandbox.env,
      CREATIVE_ARCHIVE_SOCKET: join(tmpdir(), `ca2b-${randomBytes(4).toString('hex')}.sock`),
    };
    server = new DaemonServer({ env, idleMs: 0, model: new ScriptedModelClient() });
    await server.listen();
  });

  afterEach(async () => {
    await server.close();
    sandbox.cleanup();
  });

  it('keeps a committed session usable after the core refuses to abort it', async () => {
    const client = await CoreClient.connect(server.path);
    await client.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });
    await client.request({ type: 'session.begin' });
    await client.request({ type: 'session.say', text: 'committed now' });

    await expect(client.request({ type: 'session.abort' })).rejects.toThrow(/cannot abort/);

    // Still open, still speakable, and still endable the proper way.
    const status = await client.request<{ state: string }>({ type: 'session.status' });
    expect(status.state).toBe('open');
    await expect(
      client.request({ type: 'session.say', text: 'still here' }),
    ).resolves.toBeDefined();

    const end = await client.request<{ token: string }>({ type: 'session.end' });
    await expect(
      client.request({ type: 'session.end.confirm', token: end.token }),
    ).resolves.toBeDefined();
    client.close();
  });

  it('says what to do instead of aborting', async () => {
    const client = await CoreClient.connect(server.path);
    await client.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });
    await client.request({ type: 'session.begin' });
    await client.request({ type: 'session.say', text: 'committed now' });

    await expect(client.request({ type: 'session.abort' })).rejects.toThrow(
      /ends with a confirm/,
    );
    client.close();
  });
});
