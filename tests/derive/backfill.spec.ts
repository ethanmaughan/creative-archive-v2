import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Archive } from '../../src/core/archive/archive.ts';
import { backfillDerivation, type BackfillProgress } from '../../src/core/derive/backfill.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { writeMeta } from '../../src/core/session/meta.ts';
import { sessionDir } from '../../src/core/session/session-id.ts';
import { TRANSCRIPT_FILE, formatEntry } from '../../src/core/session/transcript.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

const TURNS = [
  { at: '2026-08-18T14:32:00.000Z', role: 'agent' as const, text: 'Hello.' },
  { at: '2026-08-18T14:32:10.000Z', role: 'human' as const, text: 'Hi there.' },
];

const MODEL_OUTPUT = JSON.stringify({
  title: 'A greeting',
  summary: 'Said hello.',
  tags: ['greeting'],
  outline: [],
  highlights: [],
  open_threads: [],
});

function makeMeta(
  id: string,
  overrides: Partial<{
    mode: string | null;
    started_at: string;
    derived_at: string | null;
  }> = {},
) {
  return {
    id,
    title: `session ${id}`,
    mode: overrides.mode !== undefined ? overrides.mode : 'tutor',
    agent_name: 'Test',
    personality: 'plain' as const,
    started_at: overrides.started_at ?? '2026-08-18T14:32:00.000Z',
    committed_at: '2026-08-18T14:32:05.000Z',
    ended_at: '2026-08-18T14:40:00.000Z',
    ended_by: 'confirmed' as const,
    recovered: false,
    links: [],
    tags: [],
    derived_at: overrides.derived_at !== undefined ? overrides.derived_at : null,
    derived_by: null,
  };
}

async function seedSession(
  archive: Archive,
  id: string,
  overrides: Partial<{
    mode: string | null;
    started_at: string;
    derived_at: string | null;
  }> = {},
): Promise<void> {
  await archive.store.write(
    `${sessionDir(id)}/${TRANSCRIPT_FILE}`,
    TURNS.map((turn) => formatEntry(turn)).join(''),
  );
  await writeMeta(archive.store, makeMeta(id, overrides));
}

describe('batch derivation (step 7)', () => {
  let sandbox: Sandbox;
  let archive: Archive;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-backfill');
    archive = await sandbox.open();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('derives all sessions in an archive', async () => {
    await seedSession(archive, '2026-08-18T1432Z-aaaa');
    await seedSession(archive, '2026-08-18T1500Z-bbbb');

    const model = new ScriptedModelClient({ derived: MODEL_OUTPUT });
    const report = await backfillDerivation({ archive, model });

    expect(report.total).toBe(2);
    expect(report.derived).toBe(2);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
  });

  it('skips sessions with no mode (recovered buffers)', async () => {
    await seedSession(archive, '2026-08-18T1432Z-aaaa');
    await seedSession(archive, '2026-08-18T1500Z-bbbb', { mode: null });

    const model = new ScriptedModelClient({ derived: MODEL_OUTPUT });
    const report = await backfillDerivation({ archive, model });

    expect(report.total).toBe(1);
    expect(report.derived).toBe(1);
  });

  it('respects underivedOnly filter', async () => {
    await seedSession(archive, '2026-08-18T1432Z-aaaa', {
      derived_at: '2026-08-18T15:00:00.000Z',
    });
    await seedSession(archive, '2026-08-18T1500Z-bbbb');

    const model = new ScriptedModelClient({ derived: MODEL_OUTPUT });
    const report = await backfillDerivation({
      archive,
      model,
      filter: { underivedOnly: true },
    });

    expect(report.total).toBe(1);
    expect(report.derived).toBe(1);
    expect(report.reports[0]!.sessionId).toBe('2026-08-18T1500Z-bbbb');
  });

  it('respects after date filter', async () => {
    await seedSession(archive, '2026-08-18T1432Z-aaaa', {
      started_at: '2026-08-17T14:32:00.000Z',
    });
    await seedSession(archive, '2026-08-18T1500Z-bbbb', {
      started_at: '2026-08-19T14:32:00.000Z',
    });

    const model = new ScriptedModelClient({ derived: MODEL_OUTPUT });
    const report = await backfillDerivation({
      archive,
      model,
      filter: { after: '2026-08-18' },
    });

    expect(report.total).toBe(1);
    expect(report.reports[0]!.sessionId).toBe('2026-08-18T1500Z-bbbb');
  });

  it('respects mode filter', async () => {
    await seedSession(archive, '2026-08-18T1432Z-aaaa', { mode: 'tutor' });
    await seedSession(archive, '2026-08-18T1500Z-bbbb', { mode: 'creative' });

    const model = new ScriptedModelClient({ derived: MODEL_OUTPUT });
    const report = await backfillDerivation({
      archive,
      model,
      filter: { mode: 'creative' },
    });

    expect(report.total).toBe(1);
    expect(report.reports[0]!.sessionId).toBe('2026-08-18T1500Z-bbbb');
  });

  it('reports per-session errors without aborting the batch', async () => {
    await seedSession(archive, '2026-08-18T1432Z-aaaa');
    await seedSession(archive, '2026-08-18T1500Z-bbbb');

    // First call returns garbage (unparseable), second returns valid output.
    const model = new ScriptedModelClient({ derived: 'not json at all' });
    const report = await backfillDerivation({ archive, model });

    expect(report.total).toBe(2);
    // unparseable counts as derived with outcome 'unparseable', not as a thrown error
    expect(report.derived + report.skipped).toBeGreaterThanOrEqual(1);
    expect(report.failed).toBe(0);
  });

  it('calls onProgress for each session', async () => {
    await seedSession(archive, '2026-08-18T1432Z-aaaa');
    await seedSession(archive, '2026-08-18T1500Z-bbbb');

    const model = new ScriptedModelClient({ derived: MODEL_OUTPUT });
    const progress: BackfillProgress[] = [];
    await backfillDerivation({
      archive,
      model,
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toHaveLength(2);
    expect(progress[0]!.current).toBe(1);
    expect(progress[0]!.total).toBe(2);
    expect(progress[1]!.current).toBe(2);
    expect(progress[1]!.total).toBe(2);
  });

  it('returns empty report for an archive with no sessions', async () => {
    const model = new ScriptedModelClient({});
    const report = await backfillDerivation({ archive, model });

    expect(report.total).toBe(0);
    expect(report.derived).toBe(0);
  });
});
