import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IDENTITY } from '../../src/core/identity/identity.ts';
import { readMeta } from '../../src/core/session/meta.ts';
import { readOpenSession } from '../../src/core/session/open-session.ts';
import { recoverArchive } from '../../src/core/session/recovery.ts';
import { TRANSCRIPT_FILE, parseTranscript } from '../../src/core/session/transcript.ts';
import { sessionDir } from '../../src/core/session/session-id.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'crash-session.ts');

/**
 * Invariant 2 (§5.3, crash row): a session killed mid-flight is recovered on next launch.
 *
 * Recovery is bookkeeping, not reconstruction — the transcript was already whole before the
 * process died. What recovery owes the user is an accurate record of *how* it ended.
 */
describe('invariant: a killed session recovers on next launch', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = makeSandbox('ca2-recover');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  const crash = (args: string[], env: NodeJS.ProcessEnv = {}): void => {
    const result = spawnSync(process.execPath, [FIXTURE, sandbox.archiveRoot, ...args], {
      env: { ...process.env, ...sandbox.env, ...env },
      encoding: 'utf8',
    });
    expect(result.signal).toBe('SIGKILL');
  };

  it('closes out a committed session as a crash without touching its transcript', async () => {
    crash(['the mission chapters repeat', 'and I cannot see why']);

    const archive = await sandbox.open();
    const sessionId = (await readOpenSession(archive.store))!.session_id;
    const before = await archive.store.read(`${sessionDir(sessionId)}/${TRANSCRIPT_FILE}`);

    const report = await recoverArchive(archive, { identity: DEFAULT_IDENTITY });

    expect(report.crashedSessions).toEqual([sessionId]);
    const meta = await readMeta(archive.store, sessionId);
    expect(meta.ended_by).toBe('crash');
    expect(meta.recovered).toBe(true);
    expect(meta.ended_at).not.toBeNull();

    // Ground truth is untouched: recovery writes metadata, never the transcript.
    expect(await archive.store.read(`${sessionDir(sessionId)}/${TRANSCRIPT_FILE}`)).toBe(
      before,
    );
    expect(await readOpenSession(archive.store)).toBeNull();
  });

  it('is idempotent — a second launch finds nothing left to recover', async () => {
    crash(['something']);
    const archive = await sandbox.open();

    const first = await recoverArchive(archive, { identity: DEFAULT_IDENTITY });
    const second = await recoverArchive(archive, { identity: DEFAULT_IDENTITY });

    expect(first.crashedSessions).toHaveLength(1);
    expect(second).toEqual({ crashedSessions: [], promotedBuffers: [], discardedBuffers: [] });
  });

  it('promotes an orphaned buffer rather than discarding the preamble (D-009)', async () => {
    crash(['I have been staring at this for two hours'], { CRASH_BEFORE_COMMIT: '1' });

    const archive = await sandbox.open();
    const report = await recoverArchive(archive, { identity: DEFAULT_IDENTITY });

    expect(report.promotedBuffers).toHaveLength(1);
    const id = report.promotedBuffers[0]!;
    const meta = await readMeta(archive.store, id);

    // Intake never resolved, so there is genuinely no mode. Recording null is honest;
    // defaulting would put a scope claim in the record that nobody made.
    expect(meta.mode).toBeNull();
    expect(meta.recovered).toBe(true);
    expect(meta.ended_by).toBe('crash');
    expect(meta.title).toContain('staring at this');

    const entries = parseTranscript(
      await archive.store.read(`${sessionDir(id)}/${TRANSCRIPT_FILE}`),
    );
    expect(entries.some((entry) => entry.text.includes('two hours'))).toBe(true);
    expect(await archive.store.list('.creative-archive/scratch')).toEqual([]);
  });

  it('discards a buffer in which nothing was ever said', async () => {
    const archive = await sandbox.open();
    await archive.store.write(
      '.creative-archive/scratch/pending-2026-08-18T1432Z-aaaa.md',
      "## 2026-08-18T14:32:00.000Z agent\n\nWhat's going on?\n\n",
    );

    const report = await recoverArchive(archive, { identity: DEFAULT_IDENTITY });

    expect(report.discardedBuffers).toHaveLength(1);
    expect(report.promotedBuffers).toEqual([]);
    expect(await archive.store.exists('sessions')).toBe(false);
  });
});
