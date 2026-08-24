import type { CapabilityName } from './validate.ts';
import { sessionDir } from '../session/session-id.ts';
import type { FileStore } from '../storage/file-store.ts';

/**
 * Capability audit trail (§6.5).
 *
 * Every capability exercise appends to a session-scoped, append-only log. Same discipline as
 * the transcript — ground truth, never edited. Prerequisite for granting any new capability.
 *
 * Format: newline-delimited JSON, one entry per line.
 */

export const AUDIT_FILE = 'audit.log';

export interface AuditEntry {
  readonly at: string;
  readonly capability: CapabilityName;
  readonly args: unknown;
  readonly outcome: 'ok' | 'denied' | 'error';
  readonly error?: string | undefined;
  readonly spend?: number | undefined;
}

export function auditPath(sessionId: string): string {
  return `${sessionDir(sessionId)}/${AUDIT_FILE}`;
}

export function formatAuditEntry(entry: AuditEntry): string {
  return `${JSON.stringify(entry)}\n`;
}

export async function appendAudit(
  store: FileStore,
  sessionId: string,
  entry: AuditEntry,
): Promise<void> {
  const path = auditPath(sessionId);
  const existing = (await store.exists(path)) ? await store.read(path) : '';
  await store.write(path, existing + formatAuditEntry(entry));
}

export async function readAudit(store: FileStore, sessionId: string): Promise<AuditEntry[]> {
  const path = auditPath(sessionId);
  if (!(await store.exists(path))) return [];
  const raw = await store.read(path);
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEntry);
}
