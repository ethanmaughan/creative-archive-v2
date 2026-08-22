import { parse } from 'yaml';
import { ARCHIVE_INTERNAL_DIR } from '../config/paths.ts';
import { INGEST_DIR, INGEST_META, INGEST_SOURCE_DIR } from '../ingest/manifest.ts';
import { META_FILE } from '../session/meta.ts';
import { TRANSCRIPT_FILE, parseTranscript } from '../session/transcript.ts';
import type { FileStore } from '../storage/file-store.ts';
import { deepLink, headingSlug, type IndexedDocument, type Span } from './document.ts';

/**
 * Turning the archive on disk into something searchable (§8).
 *
 * Two shapes of document, because the archive has two:
 *
 *   - **Notes** — ordinary markdown, optional YAML frontmatter, split into spans at
 *     headings. A heading is where a human already decided one idea stops and the next
 *     begins, so it is a better boundary than any window this code could pick.
 *   - **Sessions** — `transcript.md` has no frontmatter by design (D-011), so its metadata
 *     comes from the sibling `meta.yaml` and each conversational turn is its own span. A
 *     turn is the natural unit: retrieving half of one is retrieving nothing.
 */

/** Never indexed: core state, version control, and dependency trees. */
const SKIP_DIRS = new Set([ARCHIVE_INTERNAL_DIR, '.git', 'node_modules']);

/**
 * A session's derived minutes are not source material, so they are not indexed.
 *
 * Left in, `session.md` was indexed as an ordinary note — provenance `note`, title from its
 * own heading — which made a model-written summary indistinguishable from something the user
 * wrote by hand, and gave it two spans competing with the transcript turns it was summarizing.
 * Retrieved and quoted back in a later session, that is §5.5's failure exactly: a
 * reconstruction that reads like a record.
 *
 * Nothing is lost from retrieval: the transcript the summary was derived from is indexed.
 */
function isDerivedLayer(path: string): boolean {
  return (
    (path.startsWith('sessions/') && path.endsWith('/session.md')) ||
    (path.startsWith(`${INGEST_DIR}/`) && path.endsWith('/parsed.md'))
  );
}

/** `ingest/<id>/source/<file>` — the original, whatever its extension. */
function ingestSource(path: string): { id: string; filename: string } | null {
  const parts = path.split('/');
  if (parts.length !== 4) return null;
  if (parts[0] !== INGEST_DIR || parts[2] !== INGEST_SOURCE_DIR) return null;
  return { id: parts[1]!, filename: parts[3]! };
}

export interface ScanResult {
  readonly documents: IndexedDocument[];
  readonly filesRead: number;
  readonly skipped: string[];
}

export async function scanArchive(store: FileStore): Promise<ScanResult> {
  const documents: IndexedDocument[] = [];
  const skipped: string[] = [];
  let filesRead = 0;

  const paths: string[] = [];
  const queue = ['.'];

  while (queue.length > 0) {
    const dir = queue.pop()!;
    let entries;
    try {
      entries = await store.list(dir);
    } catch {
      // A directory that vanished mid-walk, or one we cannot read. Note it and move on;
      // an index that fails entirely because of one unreadable folder is worse than an
      // index that tells you what it could not see.
      skipped.push(dir);
      continue;
    }

    for (const entry of entries) {
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1);
      if (entry.kind === 'dir') {
        if (!SKIP_DIRS.has(name)) queue.push(entry.path);
        continue;
      }
      if (isDerivedLayer(entry.path)) continue;
      // Ingested originals are indexed whatever they are named: material brought in as .txt
      // or .py is exactly as searchable as material brought in as .md.
      if (name.endsWith('.md') || ingestSource(entry.path) !== null) paths.push(entry.path);
    }
  }

  for (const path of paths.sort()) {
    filesRead += 1;
    let raw: string;
    try {
      raw = await store.read(path);
    } catch {
      skipped.push(path);
      continue;
    }

    const ingested = ingestSource(path);
    const document = path.endsWith(`/${TRANSCRIPT_FILE}`)
      ? await readSession(store, path, raw)
      : ingested === null
        ? readNote(path, raw)
        : await readIngested(store, path, raw, ingested.id);

    if (document !== null) documents.push(document);
  }

  return { documents, filesRead, skipped };
}

interface Frontmatter {
  readonly data: Record<string, unknown>;
  readonly body: string;
  readonly bodyStartLine: number;
}

/** Split leading `---` delimited YAML off a markdown file. Malformed frontmatter is body. */
export function splitFrontmatter(raw: string): Frontmatter {
  if (!raw.startsWith('---\n')) return { data: {}, body: raw, bodyStartLine: 1 };

  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: raw, bodyStartLine: 1 };

  const yamlText = raw.slice(4, end + 1);
  const after = raw.indexOf('\n', end + 1);
  const body = after === -1 ? '' : raw.slice(after + 1);

  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parse(yamlText);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    return { data: {}, body: raw, bodyStartLine: 1 };
  }

  return { data, body, bodyStartLine: raw.slice(0, after + 1).split('\n').length };
}

function readNote(path: string, raw: string): IndexedDocument | null {
  const { data, body, bodyStartLine } = splitFrontmatter(raw);
  const spans = headingSpans(path, body, bodyStartLine);
  if (spans.length === 0) return null;

  return {
    path,
    provenance: 'note',
    title: stringField(data, 'title') ?? firstHeading(body) ?? basename(path),
    date: dateField(data),
    tags: stringArrayField(data, 'tags'),
    mode: null,
    agent: null,
    spans,
  };
}

async function readSession(
  store: FileStore,
  path: string,
  raw: string,
): Promise<IndexedDocument | null> {
  const metaPath = `${path.slice(0, -TRANSCRIPT_FILE.length)}${META_FILE}`;
  let meta: Record<string, unknown> = {};
  if (await store.exists(metaPath)) {
    try {
      const parsed: unknown = parse(await store.read(metaPath));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // A corrupt meta.yaml costs the session its metadata, not its searchability. The
      // transcript is the ground truth and stays indexed either way.
    }
  }

  const entries = parseTranscript(raw);
  if (entries.length === 0) return null;

  let line = 1;
  const spans: Span[] = entries.map((entry) => {
    const at = line;
    line += entry.text.split('\n').length + 3; // header + blank + body + blank
    return {
      anchor: entry.at,
      heading: entry.role,
      text: entry.text,
      deepLink: deepLink(path, entry.at),
      line: at,
    };
  });

  const started = stringField(meta, 'started_at');
  return {
    path,
    provenance: 'session',
    title: stringField(meta, 'title') ?? path,
    date: started === undefined ? null : started.slice(0, 10) || null,
    tags: stringArrayField(meta, 'tags'),
    mode: stringField(meta, 'mode') ?? null,
    agent: stringField(meta, 'agent_name') ?? null,
    spans,
  };
}

/**
 * An ingested original (§5.5), described by its declared manifest rather than by anything
 * inferred from the file. Its own frontmatter is left alone — the file is not ours to read as
 * configuration, only to index.
 */
async function readIngested(
  store: FileStore,
  path: string,
  raw: string,
  id: string,
): Promise<IndexedDocument | null> {
  const spans = headingSpans(path, raw, 1);
  if (spans.length === 0) return null;

  let meta: Record<string, unknown> = {};
  const metaPath = `${INGEST_DIR}/${id}/${INGEST_META}`;
  if (await store.exists(metaPath)) {
    try {
      const parsed: unknown = parse(await store.read(metaPath));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
      }
    } catch {
      // A corrupt manifest costs the item its declared metadata, not its searchability.
    }
  }

  return {
    path,
    provenance: 'ingest',
    title: stringField(meta, 'subject') ?? basename(path),
    date: dateField(meta) ?? null,
    tags: stringArrayField(meta, 'tags'),
    mode: null,
    agent: null,
    spans,
  };
}

/** Split a body at markdown headings. Text before the first heading is its own span. */
export function headingSpans(path: string, body: string, startLine: number): Span[] {
  const lines = body.split('\n');
  const spans: Span[] = [];

  let heading: string | null = null;
  let anchor = '';
  let buffer: string[] = [];
  let spanLine = startLine;

  const flush = (): void => {
    const text = buffer.join('\n').trim();
    if (text.length > 0 || heading !== null) {
      spans.push({
        anchor,
        heading,
        text: heading === null ? text : `${heading}\n\n${text}`.trim(),
        deepLink: deepLink(path, anchor),
        line: spanLine,
      });
    }
    buffer = [];
  };

  lines.forEach((line, offset) => {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match === null) {
      buffer.push(line);
      return;
    }
    flush();
    heading = match[2]!.trim();
    anchor = headingSlug(heading);
    spanLine = startLine + offset;
  });
  flush();

  return spans;
}

function firstHeading(body: string): string | undefined {
  return /^#{1,6}\s+(.*)$/m.exec(body)?.[1]?.trim();
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayField(data: Record<string, unknown>, key: string): string[] {
  const value = data[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/^#/, '').toLowerCase());
}

/** `date`, or a session's `started_at`, normalized to YYYY-MM-DD for range queries. */
function dateField(data: Record<string, unknown>): string | null {
  for (const key of ['date', 'authored_on', 'started_at', 'created']) {
    const value = data[key];
    if (typeof value === 'string') {
      const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
      if (match !== null) return match[0];
    }
    if (value instanceof Date) return value.toISOString().slice(0, 10);
  }
  return null;
}
