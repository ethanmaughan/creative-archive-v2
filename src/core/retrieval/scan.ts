import { parse } from 'yaml';
import { ARCHIVE_INTERNAL_DIR } from '../config/paths.ts';
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

export interface ScanResult {
  readonly documents: IndexedDocument[];
  readonly filesRead: number;
  readonly skipped: string[];
}

export async function scanArchive(store: FileStore): Promise<ScanResult> {
  const documents: IndexedDocument[] = [];
  const skipped: string[] = [];
  let filesRead = 0;

  const markdown: string[] = [];
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
      if (name.endsWith('.md')) markdown.push(entry.path);
    }
  }

  for (const path of markdown.sort()) {
    filesRead += 1;
    let raw: string;
    try {
      raw = await store.read(path);
    } catch {
      skipped.push(path);
      continue;
    }

    const document = path.endsWith(`/${TRANSCRIPT_FILE}`)
      ? await readSession(store, path, raw)
      : readNote(path, raw);

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
  for (const key of ['date', 'started_at', 'created']) {
    const value = data[key];
    if (typeof value === 'string') {
      const match = /^\d{4}-\d{2}-\d{2}/.exec(value);
      if (match !== null) return match[0];
    }
    if (value instanceof Date) return value.toISOString().slice(0, 10);
  }
  return null;
}
