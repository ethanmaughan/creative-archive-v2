import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ConfigInvalid } from '../errors.ts';
import { PERSONALITY_IDS } from '../identity/personality.ts';
import type { FileStore } from '../storage/file-store.ts';
import { sessionDir } from './session-id.ts';

export const META_FILE = 'meta.yaml';

/**
 * How a session stopped (§5.3). `crash` is written by recovery on the next launch, not by
 * the dying process — that is the whole reason the transcript is already on disk.
 */
export const END_REASONS = ['confirmed', 'idle', 'crash'] as const;

export type EndReason = (typeof END_REASONS)[number];

const MetaSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    /** Null only for a session recovered from a scratch buffer that never reached intake. */
    mode: z.string().min(1).nullable(),
    agent_name: z.string().min(1),
    personality: z.enum(PERSONALITY_IDS),
    started_at: z.string().min(1),
    committed_at: z.string().min(1),
    ended_at: z.string().min(1).nullable(),
    ended_by: z.enum(END_REASONS).nullable(),
    recovered: z.boolean(),
    links: z.array(z.string()),
    /** Topic tags from the derivation pass (§5.4 frontmatter enrichment). */
    tags: z.array(z.string()),
    /** When the derived layer was last produced, and by which model. Null until derived. */
    derived_at: z.string().min(1).nullable(),
    derived_by: z.string().min(1).nullable(),
  })
  .strict();

export type SessionMeta = z.infer<typeof MetaSchema>;

export function metaPath(id: string): string {
  return `${sessionDir(id)}/${META_FILE}`;
}

/**
 * meta.yaml is derived and rewritable — unlike the transcript. Personality is recorded here
 * as a fact about the session (§7); it is never applied to anything under this file.
 */
export async function writeMeta(store: FileStore, meta: SessionMeta): Promise<void> {
  const validated = MetaSchema.parse(meta);
  const header =
    '# Session metadata (§7). Derived and safe to correct — the transcript beside it is\n' +
    '# ground truth and is never edited (§10.7).\n';
  await store.write(metaPath(validated.id), header + stringify(validated));
}

export async function readMeta(store: FileStore, id: string): Promise<SessionMeta> {
  const path = metaPath(id);
  const parsed = MetaSchema.safeParse(parse(await store.read(path)) ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigInvalid(path, detail);
  }
  return parsed.data;
}
