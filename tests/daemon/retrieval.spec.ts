import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoreClient } from '../../src/adapters/text/client.ts';
import { DaemonServer } from '../../src/core/daemon/server.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import type { IndexStats } from '../../src/core/retrieval/index.ts';
import type { RetrievalResult } from '../../src/core/retrieval/retrieve.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

/**
 * Retrieval over the wire, and the property that makes §1's "sessions become new archive
 * content, so the system feeds itself" true rather than aspirational: what you said in the
 * last session is findable in the next one.
 */
describe('daemon retrieval', () => {
  let sandbox: Sandbox;
  let server: DaemonServer;
  let env: NodeJS.ProcessEnv;

  const start = async (): Promise<void> => {
    server = new DaemonServer({
      env,
      idleMs: 0,
      model: new ScriptedModelClient({ replies: ['Which step?'] }),
    });
    await server.listen();
  };

  const attach = async (): Promise<CoreClient> => {
    const client = await CoreClient.connect(server.path);
    await client.request({ type: 'attach', archive: sandbox.archiveRoot, mode: 'tutor' });
    return client;
  };

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-daemon-retrieval');
    env = {
      ...sandbox.env,
      CREATIVE_ARCHIVE_SOCKET: join(tmpdir(), `ca2r-${randomBytes(4).toString('hex')}.sock`),
    };

    const archive = await sandbox.open();
    await archive.store.write(
      'notes/row-reduction.md',
      '---\ntitle: Row reduction\ntags: [linalg]\ndate: 2026-03-04\n---\n\n## Pivots\n\nChoose the leftmost nonzero pivot.\n',
    );
  });

  afterEach(async () => {
    await server.close();
    sandbox.cleanup();
  });

  it('reports the index it built when a client attaches', async () => {
    await start();
    const client = await CoreClient.connect(server.path);
    const attached = await client.request<{ index: IndexStats }>({
      type: 'attach',
      archive: sandbox.archiveRoot,
      mode: 'tutor',
    });

    expect(attached.index.documents).toBe(1);
    expect(attached.index.spans).toBe(1);
    expect(attached.index.generation).toBe(1);
    client.close();
  });

  it('searches the archive from an open session', async () => {
    await start();
    const client = await attach();
    await client.request({ type: 'session.begin' });

    const result = await client.request<RetrievalResult>({
      type: 'session.search',
      query: 'pivot',
    });

    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]!.deepLink).toBe('notes/row-reduction.md#pivots');
    expect(result.searched.generation).toBe(1);
    client.close();
  });

  it('makes a finished session searchable in the next one (§1)', async () => {
    await start();
    const first = await attach();
    await first.request({ type: 'session.begin' });
    await first.request({
      type: 'session.say',
      text: 'the determinant vanishes whenever the columns are dependent',
    });

    const end = await first.request<{ token: string }>({ type: 'session.end' });
    await first.request({ type: 'session.end.confirm', token: end.token });
    first.close();

    const second = await attach();
    await second.request({ type: 'session.begin' });
    const result = await second.request<RetrievalResult>({
      type: 'session.search',
      query: 'determinant vanishes',
    });

    expect(result.spans.length).toBeGreaterThan(0);
    expect(result.spans[0]!.provenance).toBe('session');
    expect(result.spans[0]!.text).toContain('determinant vanishes');
    // The rebuild is visible: a report naming generation 2 means something different.
    expect(result.searched.generation).toBe(2);
    second.close();
  });

  it('marks the index stale on session close rather than rebuilding eagerly', async () => {
    await start();
    const client = await attach();
    await client.request({ type: 'session.begin' });
    await client.request({ type: 'session.say', text: 'something worth finding later' });

    const end = await client.request<{ token: string }>({ type: 'session.end' });
    await client.request({ type: 'session.end.confirm', token: end.token });

    const status = await client.request<{ stats: IndexStats; stale: boolean }>({
      type: 'index.status',
    });
    expect(status.stale).toBe(true);
    expect(status.stats.generation).toBe(1);
    client.close();
  });

  it('rebuilds on request', async () => {
    await start();
    const client = await attach();
    const archive = await sandbox.open();
    await archive.store.write(
      'notes/second.md',
      '## Later\n\nadded after the index was built\n',
    );

    const before = await client.request<{ stats: IndexStats }>({ type: 'index.status' });
    expect(before.stats.documents).toBe(1);

    const after = await client.request<IndexStats>({ type: 'index.rebuild' });
    expect(after.documents).toBe(2);
    expect(after.generation).toBe(2);
    client.close();
  });

  it('refuses to search without a session, and reports why', async () => {
    await start();
    const client = await attach();
    await expect(client.request({ type: 'session.search', query: 'pivot' })).rejects.toThrow(
      /no session/,
    );
    client.close();
  });
});
