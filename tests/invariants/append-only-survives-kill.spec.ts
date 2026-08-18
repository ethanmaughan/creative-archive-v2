import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOpenSession } from '../../src/core/session/open-session.ts';
import { sessionDir } from '../../src/core/session/session-id.ts';
import { TRANSCRIPT_FILE, parseTranscript } from '../../src/core/session/transcript.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'crash-session.ts');

/**
 * Invariant 1 (§5.2, §7.1): the transcript is written continuously and is never held in
 * memory pending a final write.
 *
 * The only honest way to test this is to kill a real process with no chance to flush. A
 * ninety-minute session lost to a crash is the failure that gets the tool abandoned, so it
 * gets the test that actually reproduces the crash.
 */
describe('invariant: append-only transcript survives a killed process', () => {
  let sandbox: Sandbox;

  const crash = (...args: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [FIXTURE, sandbox.archiveRoot, ...args], {
      env: { ...process.env, ...sandbox.env },
      encoding: 'utf8',
    });

  beforeEach(() => {
    sandbox = makeSandbox('ca2-crash');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('keeps every utterance written before a SIGKILL', async () => {
    const said = ['the mission chapters repeat', 'and I cannot see why', 'third thing'];
    const result = crash(...said);
    expect(result.signal).toBe('SIGKILL');

    const archive = await sandbox.open();
    const pointer = await readOpenSession(archive.store);
    expect(pointer, 'the dying process had committed a session').not.toBeNull();

    const raw = await archive.store.read(`${sessionDir(pointer!.session_id)}/${TRANSCRIPT_FILE}`);
    const entries = parseTranscript(raw);

    for (const utterance of said) {
      expect(entries.some((entry) => entry.text === utterance), utterance).toBe(true);
    }
    // Both sides survived, not just the human's half.
    expect(entries.filter((entry) => entry.role === 'agent').length).toBe(said.length + 1);
  });

  it('keeps a pre-commit buffer that was never flushed into a session folder', async () => {
    const result = spawnSync(
      process.execPath,
      [FIXTURE, sandbox.archiveRoot, 'I am annoyed and have not said what about yet'],
      { env: { ...process.env, ...sandbox.env, CRASH_BEFORE_COMMIT: '1' }, encoding: 'utf8' },
    );
    expect(result.signal).toBe('SIGKILL');

    const archive = await sandbox.open();
    expect(await readOpenSession(archive.store)).toBeNull();

    const buffers = await archive.store.list('.creative-archive/scratch');
    const transcripts = buffers.filter((path) => path.endsWith('.md'));
    expect(transcripts).toHaveLength(1);

    const raw = await archive.store.read(transcripts[0]!);
    expect(raw).toContain('I am annoyed and have not said what about yet');
  });

  it('leaves no session folder behind when the crash happened before intake resolved', async () => {
    spawnSync(process.execPath, [FIXTURE, sandbox.archiveRoot, 'nothing scoped yet'], {
      env: { ...process.env, ...sandbox.env, CRASH_BEFORE_COMMIT: '1' },
      encoding: 'utf8',
    });

    const archive = await sandbox.open();
    expect(await archive.store.exists('sessions')).toBe(false);
  });
});
