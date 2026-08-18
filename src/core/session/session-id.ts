import { randomBytes } from 'node:crypto';

/**
 * Session folder IDs (§7, invariant 7): `2026-08-17T1432Z-a7f3`.
 *
 * A timestamp and a random suffix, never the subject. The human-readable title lives in
 * meta.yaml instead, because a folder named for its subject invites renaming, and a rename
 * breaks every deep link pointing at it. Folders are never renamed; titles are free to
 * change.
 *
 * The suffix disambiguates two sessions opened in the same minute; it is not a checksum
 * and carries no meaning.
 */
export function newSessionId(at: Date = new Date()): string {
  return `${formatStamp(at)}-${randomBytes(2).toString('hex')}`;
}

export function formatStamp(at: Date): string {
  const iso = at.toISOString(); // 2026-08-17T14:32:11.412Z
  const date = iso.slice(0, 10);
  const hours = iso.slice(11, 13);
  const minutes = iso.slice(14, 16);
  return `${date}T${hours}${minutes}Z`;
}

const SESSION_ID = /^\d{4}-\d{2}-\d{2}T\d{4}Z-[0-9a-f]{4}$/;

export function isSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

export function sessionDir(id: string): string {
  return `sessions/${id}`;
}
