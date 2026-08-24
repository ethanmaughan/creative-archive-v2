import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendAudit,
  auditPath,
  readAudit,
  type AuditEntry,
} from '../../src/core/capabilities/audit.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';
import type { Archive } from '../../src/core/archive/archive.ts';

const SESSION_ID = '2026-08-18T1432Z-a7f3';

describe('capability audit trail (§6.5)', () => {
  let sandbox: Sandbox;
  let archive: Archive;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-audit');
    archive = await sandbox.open();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('appends an entry in NDJSON format', async () => {
    const entry: AuditEntry = {
      at: '2026-08-18T14:32:00.000Z',
      capability: 'fs_read',
      args: { path: 'sessions/test/transcript.md' },
      outcome: 'ok',
    };

    await appendAudit(archive.store, SESSION_ID, entry);

    const raw = await archive.store.read(auditPath(SESSION_ID));
    const parsed = JSON.parse(raw.trim());
    expect(parsed.capability).toBe('fs_read');
    expect(parsed.outcome).toBe('ok');
  });

  it('reads back parsed entries', async () => {
    await appendAudit(archive.store, SESSION_ID, {
      at: '2026-08-18T14:32:00.000Z',
      capability: 'fs_read',
      args: { path: 'test.md' },
      outcome: 'ok',
    });
    await appendAudit(archive.store, SESSION_ID, {
      at: '2026-08-18T14:33:00.000Z',
      capability: 'model_call',
      args: { prompt: 'hello' },
      outcome: 'ok',
      spend: 0.002,
    });

    const entries = await readAudit(archive.store, SESSION_ID);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.capability).toBe('fs_read');
    expect(entries[1]!.capability).toBe('model_call');
    expect(entries[1]!.spend).toBe(0.002);
  });

  it('records denied outcomes', async () => {
    await appendAudit(archive.store, SESSION_ID, {
      at: '2026-08-18T14:32:00.000Z',
      capability: 'execute',
      args: { command: 'rm -rf /' },
      outcome: 'denied',
      error: 'capability not granted',
    });

    const entries = await readAudit(archive.store, SESSION_ID);
    expect(entries[0]!.outcome).toBe('denied');
    expect(entries[0]!.error).toBe('capability not granted');
  });

  it('is append-only — second write adds, does not replace', async () => {
    await appendAudit(archive.store, SESSION_ID, {
      at: '2026-08-18T14:32:00.000Z',
      capability: 'fs_read',
      args: {},
      outcome: 'ok',
    });
    await appendAudit(archive.store, SESSION_ID, {
      at: '2026-08-18T14:33:00.000Z',
      capability: 'fs_write',
      args: {},
      outcome: 'ok',
    });

    const entries = await readAudit(archive.store, SESSION_ID);
    expect(entries).toHaveLength(2);
  });

  it('returns empty array for a session with no audit log', async () => {
    const entries = await readAudit(archive.store, 'nonexistent-id');
    expect(entries).toEqual([]);
  });
});
