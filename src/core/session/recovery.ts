import type { Archive } from '../archive/archive.ts';
import type { Identity } from '../identity/identity.ts';
import { titleFromUtterance } from './intake.ts';
import { readMeta, writeMeta, type SessionMeta } from './meta.ts';
import { clearOpenSession, readOpenSession } from './open-session.ts';
import { SCRATCH_DIR, parseScratchSidecar } from './session.ts';
import { newSessionId, sessionDir } from './session-id.ts';
import { TRANSCRIPT_FILE, parseTranscript } from './transcript.ts';

export interface RecoveryReport {
  /** Committed sessions whose process died; closed out as `crash`. */
  readonly crashedSessions: string[];
  /** Pre-commit buffers with content, promoted to session folders (D-009). */
  readonly promotedBuffers: string[];
  /** Pre-commit buffers with nothing in them, removed. */
  readonly discardedBuffers: string[];
}

export interface RecoveryOptions {
  readonly identity: Identity;
  readonly now?: () => Date;
}

/**
 * Crash recovery (§5.3, third row).
 *
 * There is nothing to reconstruct: the transcript was written through as it happened, so
 * recovery only closes the books. It runs at launch, before any session opens — a scratch
 * file belonging to a live session would otherwise look identical to an orphaned one.
 */
export async function recoverArchive(
  archive: Archive,
  options: RecoveryOptions,
): Promise<RecoveryReport> {
  const now = options.now ?? ((): Date => new Date());
  const store = archive.store;

  const crashedSessions: string[] = [];
  const promotedBuffers: string[] = [];
  const discardedBuffers: string[] = [];

  const pointer = await readOpenSession(store);
  if (pointer !== null) {
    let meta: SessionMeta | null = null;
    try {
      meta = await readMeta(store, pointer.session_id);
    } catch {
      // The process can die between the transcript landing and meta.yaml being written.
      // The transcript is the ground truth, so leave meta null and rebuild the metadata
      // around the transcript rather than treating the session as lost.
    }

    const dir = sessionDir(pointer.session_id);
    if (await store.exists(`${dir}/${TRANSCRIPT_FILE}`)) {
      await writeMeta(store, {
        id: pointer.session_id,
        title: meta?.title ?? (await titleFromTranscript(archive, pointer.session_id)),
        mode: meta?.mode ?? null,
        agent_name: meta?.agent_name ?? options.identity.name,
        personality: meta?.personality ?? options.identity.personality,
        started_at: meta?.started_at ?? pointer.opened_at,
        committed_at: meta?.committed_at ?? pointer.opened_at,
        ended_at: now().toISOString(),
        ended_by: 'crash',
        recovered: true,
        links: meta?.links ?? [],
      });
      crashedSessions.push(pointer.session_id);
    }

    await clearOpenSession(store);
  }

  if (await store.exists(SCRATCH_DIR)) {
    for (const path of await store.list(SCRATCH_DIR)) {
      if (!path.endsWith('.md')) continue;

      const scratchId = path.slice(SCRATCH_DIR.length + 1, -'.md'.length);
      const sidecarPath = `${SCRATCH_DIR}/${scratchId}.yaml`;
      const raw = await store.read(path);
      const entries = parseTranscript(raw);
      const said = entries.filter((entry) => entry.role !== 'agent' && entry.text.length > 0);

      // Only the greeting was ever written: nothing was said, so there is nothing to keep.
      if (said.length === 0) {
        await store.remove(path);
        await store.remove(sidecarPath);
        discardedBuffers.push(scratchId);
        continue;
      }

      const sidecar = (await store.exists(sidecarPath))
        ? parseScratchSidecar(await store.read(sidecarPath))
        : null;
      const startedAt = sidecar?.started_at ?? entries[0]?.at ?? now().toISOString();

      const id = newSessionId(new Date(startedAt));
      const dir = sessionDir(id);
      await store.mkdir(dir);
      await store.rename(path, `${dir}/${TRANSCRIPT_FILE}`);
      await store.remove(sidecarPath);

      await writeMeta(store, {
        id,
        title: titleFromUtterance(said[0]!.text),
        // Intake never resolved, so this session genuinely has no mode. Recording null is
        // honest; picking a default would put a scope claim in the record that no one made.
        mode: null,
        agent_name: options.identity.name,
        personality: options.identity.personality,
        started_at: startedAt,
        committed_at: now().toISOString(),
        ended_at: now().toISOString(),
        ended_by: 'crash',
        recovered: true,
        links: [],
      });

      promotedBuffers.push(id);
    }
  }

  return { crashedSessions, promotedBuffers, discardedBuffers };
}

async function titleFromTranscript(archive: Archive, sessionId: string): Promise<string> {
  const raw = await archive.store.read(`${sessionDir(sessionId)}/${TRANSCRIPT_FILE}`);
  const first = parseTranscript(raw).find((entry) => entry.role === 'human');
  return first === undefined ? 'Recovered session' : titleFromUtterance(first.text);
}
