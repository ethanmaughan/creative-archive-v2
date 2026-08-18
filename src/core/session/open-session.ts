import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ARCHIVE_INTERNAL_DIR } from '../config/paths.ts';
import type { FileStore } from '../storage/file-store.ts';

/**
 * The crash marker (§5.3).
 *
 * Written when a session commits, deleted when it closes cleanly. Its presence on the next
 * launch means the process died with a session open — the transcript is already whole on
 * disk, so recovery is bookkeeping rather than reconstruction.
 */
export const OPEN_SESSION_PATH = `${ARCHIVE_INTERNAL_DIR}/open-session.yaml`;

const PointerSchema = z
  .object({
    session_id: z.string().min(1),
    opened_at: z.string().min(1),
    pid: z.number().int(),
  })
  .strict();

export type OpenSessionPointer = z.infer<typeof PointerSchema>;

export async function writeOpenSession(
  store: FileStore,
  pointer: OpenSessionPointer,
): Promise<void> {
  await store.write(
    OPEN_SESSION_PATH,
    '# A session was open when this was written. If it is still here at launch, the\n' +
      '# process died mid-session and recovery will close it out (§5.3).\n' +
      stringify(PointerSchema.parse(pointer)),
  );
}

export async function readOpenSession(store: FileStore): Promise<OpenSessionPointer | null> {
  if (!(await store.exists(OPEN_SESSION_PATH))) return null;
  const parsed = PointerSchema.safeParse(parse(await store.read(OPEN_SESSION_PATH)) ?? {});
  return parsed.success ? parsed.data : null;
}

export async function clearOpenSession(store: FileStore): Promise<void> {
  await store.remove(OPEN_SESSION_PATH);
}
