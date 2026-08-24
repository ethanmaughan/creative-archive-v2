import type { Archive } from '../archive/archive.ts';
import type { Legend } from '../markers/legend.ts';
import type { ModelClient } from '../model/model-client.ts';
import { loadMode } from '../modes/mode.ts';
import { readMeta } from '../session/meta.ts';
import { isSessionId } from '../session/session-id.ts';
import { deriveSession, type DerivationReport } from './derive.ts';

/**
 * Batch derivation (§5.4 step 7): re-run the post-session pass across the archive.
 *
 * Everything the pass writes is disposable and regenerable (§5.4), so re-running it when the
 * prompts improve is the whole point — and an archive with hundreds of sessions needs a way to
 * do that without typing each session ID by hand.
 */

export interface BackfillFilter {
  readonly mode?: string | undefined;
  readonly after?: string | undefined;
  readonly underivedOnly?: boolean | undefined;
}

export interface BackfillOptions {
  readonly archive: Archive;
  readonly model: ModelClient;
  readonly legend?: Legend | undefined;
  readonly filter?: BackfillFilter | undefined;
  readonly onProgress?: ((progress: BackfillProgress) => void) | undefined;
}

export interface BackfillProgress {
  readonly current: number;
  readonly total: number;
  readonly sessionId: string;
}

export interface BackfillReport {
  readonly total: number;
  readonly derived: number;
  readonly skipped: number;
  readonly failed: number;
  readonly reports: readonly DerivationReport[];
  readonly errors: readonly { sessionId: string; error: string }[];
}

export async function backfillDerivation(options: BackfillOptions): Promise<BackfillReport> {
  const { archive, model, legend, filter, onProgress } = options;

  // Discover all session folders.
  const sessionsExist = await archive.store.exists('sessions');
  if (!sessionsExist) {
    return { total: 0, derived: 0, skipped: 0, failed: 0, reports: [], errors: [] };
  }

  const entries = await archive.store.list('sessions');
  const sessionIds = entries
    .filter((e) => e.kind === 'dir' && isSessionId(e.path.split('/').pop()!))
    .map((e) => e.path.split('/').pop()!)
    .sort(); // chronological (IDs start with ISO date)

  // Read metadata and apply filters.
  const candidates: Array<{ id: string; mode: string }> = [];

  for (const id of sessionIds) {
    let meta;
    try {
      meta = await readMeta(archive.store, id);
    } catch {
      continue; // corrupt or missing meta — skip silently
    }

    if (meta.mode === null) continue; // recovered buffer, no mode (D-009)
    if (filter?.mode !== undefined && meta.mode !== filter.mode) continue;
    if (filter?.after !== undefined && meta.started_at < filter.after) continue;
    if (filter?.underivedOnly === true && meta.derived_at !== null) continue;

    candidates.push({ id, mode: meta.mode });
  }

  const total = candidates.length;
  const reports: DerivationReport[] = [];
  const errors: Array<{ sessionId: string; error: string }> = [];
  let derived = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const { id, mode: modeId } = candidates[i]!;
    onProgress?.({ current: i + 1, total, sessionId: id });

    try {
      const mode = await loadMode(modeId);
      const report = await deriveSession({
        archive,
        sessionId: id,
        mode,
        model,
        ...(legend !== undefined ? { legend } : {}),
      });

      reports.push(report);
      if (report.outcome === 'derived') {
        derived++;
      } else {
        skipped++;
      }
    } catch (error) {
      failed++;
      errors.push({ sessionId: id, error: (error as Error).message });
    }
  }

  return { total, derived, skipped, failed, reports, errors };
}
