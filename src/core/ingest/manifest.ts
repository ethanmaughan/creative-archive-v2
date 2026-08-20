import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { ConfigInvalid } from '../errors.ts';
import type { FileStore } from '../storage/file-store.ts';

/**
 * The ingest manifest (§5.5, §10.1) — externally authored material brought in from outside a
 * session. A third content type: not transcript, not derived. Immutable, authored elsewhere.
 *
 * **Type is declared, never inferred.** A worked problem set and a set of reference notes are
 * the same shape to a classifier and completely different to a tutor: one is evidence of what
 * you understood at a moment in time, the other is material to learn from. Guessing wrong is
 * silent and produces a tutor working from a false model of what you know. Declaration costs
 * one field and removes the failure mode, so there is no inference here to fall back on.
 */

export const INGEST_DIR = 'ingest';
export const INGEST_META = 'meta.yaml';
export const INGEST_SOURCE_DIR = 'source';

/** §10.1. `notes` is what you pick when you do not know — never guess upward. */
export const INGEST_TYPES = ['worked-problem', 'reference', 'notes', 'artifact'] as const;

export type IngestType = (typeof INGEST_TYPES)[number];

const ManifestSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(INGEST_TYPES),
    subject: z.string().min(1),
    /**
     * §10.1: date *authored*, not date uploaded. They are frequently far apart and the tutor
     * reasons over the former — when you wrote something is what says whether it reflects
     * what you understand now.
     */
    authored_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
    /** Filename inside `source/`. The original, never modified. */
    source: z.string().min(1),
    /**
     * §5.5: scanned handwriting needs a verification pass before its parse output is trusted.
     * OCR on handwritten maths is unreliable, and a misread exponent produces a tutor
     * confidently teaching a correction to an error you did not make. Typed work, code, and
     * text documents bypass this.
     */
    scanned: z.boolean(),
    verified: z.boolean(),
    contains_solutions: z.boolean(),
    ingested_at: z.string().min(1),
    parsed_at: z.string().min(1).nullable(),
    links: z.array(z.string()),
  })
  .strict();

export type IngestManifest = z.infer<typeof ManifestSchema>;

export function ingestDir(id: string): string {
  return `${INGEST_DIR}/${id}`;
}

export function ingestMetaPath(id: string): string {
  return `${ingestDir(id)}/${INGEST_META}`;
}

export function ingestSourcePath(id: string, filename: string): string {
  return `${ingestDir(id)}/${INGEST_SOURCE_DIR}/${filename}`;
}

export async function writeIngestManifest(
  store: FileStore,
  manifest: IngestManifest,
): Promise<void> {
  const validated = ManifestSchema.parse(manifest);
  const header =
    '# Ingested material (§5.5). `source/` is the original and is never modified; anything\n' +
    '# derived from it is regenerable. Type, subject and authored date were declared, not\n' +
    '# inferred (§10.1).\n';
  await store.write(ingestMetaPath(validated.id), header + stringify(validated));
}

export async function readIngestManifest(
  store: FileStore,
  id: string,
): Promise<IngestManifest> {
  const path = ingestMetaPath(id);
  const parsed = ManifestSchema.safeParse(parse(await store.read(path)) ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigInvalid(path, detail);
  }
  return parsed.data;
}

/**
 * `2026-08-17-linalg-pset4` — authored date first, then a slug.
 *
 * §7 keeps session folders free of their subject because renaming one breaks every deep link
 * into it. The same protection here comes from the id being fixed at ingest and never
 * renamed, which is why §5.5's own example folder carries its subject.
 */
export function ingestId(authoredOn: string, label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length === 0 ? authoredOn : `${authoredOn}-${slug}`;
}
