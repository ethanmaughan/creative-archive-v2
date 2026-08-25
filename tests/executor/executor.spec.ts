import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runTask } from '../../src/core/executor/executor.ts';
import { readAudit } from '../../src/core/capabilities/audit.ts';
import type { Capabilities } from '../../src/core/capabilities/validate.ts';
import type { Archive } from '../../src/core/archive/archive.ts';
import { writeMeta } from '../../src/core/session/meta.ts';
import { sessionDir } from '../../src/core/session/session-id.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SESSION_ID = '2026-08-18T1432Z-a7f3';

async function seedSession(archive: Archive): Promise<void> {
  await archive.store.mkdir(sessionDir(SESSION_ID));
  await writeMeta(archive.store, {
    id: SESSION_ID,
    title: 'test',
    mode: 'tutor',
    agent_name: 'Test',
    personality: 'plain',
    started_at: '2026-08-18T14:32:00.000Z',
    committed_at: '2026-08-18T14:32:05.000Z',
    ended_at: null,
    ended_by: null,
    recovered: false,
    links: [],
    tags: [],
    derived_at: null,
    derived_by: null,
  });
}

describe('executor dispatch (§6.1 step 9)', () => {
  let sandbox: Sandbox;
  let archive: Archive;
  let writeDir: string;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-exec');
    archive = await sandbox.open();
    await seedSession(archive);
    writeDir = mkdtempSync(join(tmpdir(), 'ca2-exec-out-'));
  });

  afterEach(() => {
    sandbox.cleanup();
    rmSync(writeDir, { recursive: true, force: true });
  });

  it('denies file_write when capability is not granted', async () => {
    const caps: Capabilities = {};
    const result = await runTask(
      { type: 'file_write', path: join(writeDir, 'test.txt'), content: 'hello' },
      caps,
      archive.store,
      SESSION_ID,
      archive.root,
    );
    expect(result.outcome).toBe('denied');

    const audit = await readAudit(archive.store, SESSION_ID);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.outcome).toBe('denied');
  });

  it('executes file_write when capability is granted', async () => {
    const caps: Capabilities = { fs_write: [`${writeDir}/**`] };
    const result = await runTask(
      { type: 'file_write', path: join(writeDir, 'out.txt'), content: 'data' },
      caps,
      archive.store,
      SESSION_ID,
      archive.root,
    );
    expect(result.outcome).toBe('ok');
    expect(result.output).toContain(writeDir);

    const audit = await readAudit(archive.store, SESSION_ID);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.outcome).toBe('ok');
    expect(audit[0]!.capability).toBe('fs_write');
  });

  it('denies shell when execute is false', async () => {
    const caps: Capabilities = { execute: false };
    const result = await runTask(
      { type: 'shell', command: 'echo', args: ['hello'] },
      caps,
      archive.store,
      SESSION_ID,
      archive.root,
    );
    expect(result.outcome).toBe('denied');
  });

  it('executes shell when execute is granted', async () => {
    const caps: Capabilities = { execute: { cwd: '.', network: false } };
    const result = await runTask(
      { type: 'shell', command: 'echo', args: ['hello'] },
      caps,
      archive.store,
      SESSION_ID,
      archive.root,
    );
    expect(result.outcome).toBe('ok');
    expect(result.output?.trim()).toBe('hello');

    const audit = await readAudit(archive.store, SESSION_ID);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.capability).toBe('execute');
  });

  it('denies web_fetch when capability is not granted', async () => {
    const caps: Capabilities = { web_fetch: false };
    const result = await runTask(
      { type: 'web_fetch', url: 'https://example.com' },
      caps,
      archive.store,
      SESSION_ID,
      archive.root,
    );
    expect(result.outcome).toBe('denied');
  });

  it('logs every exercise to the audit trail', async () => {
    const caps: Capabilities = { execute: { cwd: '.', network: false } };

    await runTask(
      { type: 'shell', command: 'echo', args: ['first'] },
      caps,
      archive.store,
      SESSION_ID,
      archive.root,
    );
    await runTask(
      { type: 'shell', command: 'echo', args: ['second'] },
      caps,
      archive.store,
      SESSION_ID,
      archive.root,
    );

    const audit = await readAudit(archive.store, SESSION_ID);
    expect(audit).toHaveLength(2);
  });
});
