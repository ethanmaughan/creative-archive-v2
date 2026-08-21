import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import type { Archive } from '../archive/archive.ts';
import { CoreError } from '../errors.ts';
import {
  INGEST_TYPES,
  ingestDir,
  ingestId,
  ingestSourcePath,
  writeIngestManifest,
  type IngestManifest,
  type IngestType,
} from './manifest.ts';

/**
 * Bringing material in (§5.5).
 *
 * The file is copied once, from a path the user names, into `source/` — and then never
 * modified. The agent never learns where it came from: it sees the copy inside the archive and
 * nothing else, so ingest grants no standing read anywhere outside it. Reading one named file
 * on the user's explicit instruction is what ingest *is*; it is not a capability that persists
 * after the copy.
 */

export interface IngestRequest {
  readonly sourcePath: string;
  readonly type: string;
  readonly subject: string;
  readonly authoredOn: string;
  readonly scanned?: boolean;
  readonly containsSolutions?: boolean;
  readonly links?: readonly string[];
}

export interface IngestResult {
  readonly manifest: IngestManifest;
  readonly wrote: readonly string[];
  /**
   * §5.5: scanned material is held back from being trusted until a human has read the
   * extraction. Nothing here does OCR, so a scanned item arrives with no text at all — the
   * flag records that its parse output, whenever it exists, is not to be believed yet.
   */
  readonly needsVerification: boolean;
  /** Filed into the solutions partition (§5.5), where `tutor` cannot reach it. */
  readonly partitioned: boolean;
}

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.text',
  '.tex',
  '.csv',
  '.json',
  '.yaml',
  '.yml',
  '.ts',
  '.js',
  '.py',
  '.rs',
  '.java',
  '.sql',
  '.sh',
  '.html',
  '.css',
]);

export async function ingestFile(
  archive: Archive,
  request: IngestRequest,
): Promise<IngestResult> {
  if (!(INGEST_TYPES as readonly string[]).includes(request.type)) {
    throw new CoreError(
      'ingest_type',
      `unknown type '${request.type}' — declare one of ${INGEST_TYPES.join(', ')}. ` +
        `If you do not know, it is 'notes': never guess upward into 'worked-problem', which ` +
        `is the type that changes what the tutor believes about you (§10.1).`,
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(request.authoredOn)) {
    throw new CoreError(
      'ingest_authored_on',
      'authoredOn must be YYYY-MM-DD — the date the material was authored, not today (§10.1)',
    );
  }

  if (request.subject.trim().length === 0) {
    throw new CoreError('ingest_subject', 'subject is required and is not inferred (§10.1)');
  }

  const absolute = resolve(request.sourcePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new CoreError('ingest_source', `'${absolute}' is not a file`);
  }

  const filename = basename(absolute);
  const scanned = request.scanned ?? false;
  const extension = filename.slice(filename.lastIndexOf('.')).toLowerCase();

  if (!scanned && !TEXT_EXTENSIONS.has(extension)) {
    throw new CoreError(
      'ingest_unreadable',
      `'${filename}' is not a text format this build can read. Nothing here does OCR or ` +
        `document extraction, so bring it in as text, or declare it scanned to file the ` +
        `original now and verify an extraction later (§10.2).`,
    );
  }

  // §5.5: when unsure, set the flag. A false positive costs one retrieval tier; a false
  // negative quietly defeats the no-solutions contract (§3.2).
  const containsSolutions = request.containsSolutions ?? false;

  const id = uniqueId(archive, request.authoredOn, filename);
  const sourcePath = ingestSourcePath(id, filename, containsSolutions);

  // Read then write, rather than a filesystem copy: the content goes through the store, so
  // the archive is the only place this process writes.
  await archive.store.write(sourcePath, scanned ? '' : await readFile(absolute, 'utf8'));

  const manifest: IngestManifest = {
    id,
    type: request.type as IngestType,
    subject: request.subject.trim(),
    authored_on: request.authoredOn,
    source: filename,
    scanned,
    verified: false,
    contains_solutions: containsSolutions,
    ingested_at: new Date().toISOString(),
    parsed_at: null,
    links: [...(request.links ?? [])],
  };
  await writeIngestManifest(archive.store, manifest);

  return {
    manifest,
    wrote: [sourcePath, `${ingestDir(id, containsSolutions)}/meta.yaml`],
    needsVerification: scanned,
    partitioned: containsSolutions,
  };
}

/** Ids are never reused and never renamed, so a second item on one day gets a suffix. */
function uniqueId(archive: Archive, authoredOn: string, filename: string): string {
  const base = ingestId(authoredOn, filename);
  const taken = (id: string): boolean =>
    // Checked in both trees: an id is a deep link, and the same id meaning two things
    // depending on which subtree you look in would make those links ambiguous.
    existsSync(archive.store.resolve(ingestDir(id, false))) ||
    existsSync(archive.store.resolve(ingestDir(id, true)));

  if (!taken(base)) return base;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}`;
    if (!taken(candidate)) return candidate;
  }
  throw new CoreError('ingest_id', `cannot find a free id for '${base}'`);
}
