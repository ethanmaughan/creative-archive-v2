import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ARCHIVE_INTERNAL_DIR } from '../config/paths.ts';
import { ConfigInvalid } from '../errors.ts';
import type { FileStore } from '../storage/file-store.ts';
import { DEFAULT_PERSONALITY, PERSONALITY_IDS, type PersonalityId } from './personality.ts';

/**
 * Agent identity (§4), persisted **per archive** (D-003): the agent working a novel archive
 * can differ from the one working a study archive. Two independent fields — a free-text name
 * and a personality preset — and neither is a wake word (§4.1).
 */
export interface Identity {
  readonly name: string;
  readonly personality: PersonalityId;
}

export const DEFAULT_IDENTITY: Identity = { name: 'Archive', personality: DEFAULT_PERSONALITY };

export const IDENTITY_PATH = `${ARCHIVE_INTERNAL_DIR}/identity.yaml`;

const IdentityFile = z
  .object({
    name: z.string().min(1).max(120),
    personality: z.enum(PERSONALITY_IDS),
  })
  .strict();

/** Reads through the unscoped store: identity is core state, not the agent's to reach. */
export async function loadIdentity(store: FileStore): Promise<Identity> {
  if (!(await store.exists(IDENTITY_PATH))) return DEFAULT_IDENTITY;

  const parsed = IdentityFile.safeParse(parse(await store.read(IDENTITY_PATH)) ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigInvalid(IDENTITY_PATH, detail);
  }

  return { name: parsed.data.name, personality: parsed.data.personality };
}

export async function saveIdentity(store: FileStore, identity: Identity): Promise<void> {
  const validated = IdentityFile.parse(identity);
  await store.write(
    IDENTITY_PATH,
    `# Agent identity for this archive (§4). Personality is tone only and never reaches\n` +
      `# the transcript or any derived structure (§4.4).\n` +
      stringify({ name: validated.name, personality: validated.personality }),
  );
}
