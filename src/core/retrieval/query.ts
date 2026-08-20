import type { Provenance } from './document.ts';
import { tokenizeQuery } from './tokenize.ts';

/**
 * The structural query language (§8): exact date ranges, heading lookup, tag filter, and
 * full text.
 *
 * Keys are whitelisted, exactly like v1's inline-query mini-language. An unrecognized key
 * is not an error and not silently dropped — it comes back in `ignored`, so a report can
 * say "I did not understand `kind:` and searched without it". A filter that quietly does
 * nothing is the fastest way to trust a wrong answer.
 *
 *   eigenvector tag:linalg after:2026-01-01 heading:"row reduction" in:session limit:5
 */

export interface Query {
  readonly terms: readonly string[];
  readonly tags: readonly string[];
  readonly headings: readonly string[];
  readonly after: string | null;
  readonly before: string | null;
  readonly mode: string | null;
  readonly provenance: Provenance | null;
  readonly limit: number;
  readonly ignored: readonly string[];
  readonly raw: string;
}

export const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 50;

const KEYS = new Set(['tag', 'after', 'before', 'heading', 'mode', 'in', 'limit']);
const PROVENANCES = new Set<Provenance>(['note', 'session', 'ingest']);

/** Split on whitespace, keeping `key:"quoted value"` together. */
function segments(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;

  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current.length > 0) out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function parseQuery(input: string): Query {
  const tags: string[] = [];
  const headings: string[] = [];
  const ignored: string[] = [];
  const free: string[] = [];

  let after: string | null = null;
  let before: string | null = null;
  let mode: string | null = null;
  let provenance: Provenance | null = null;
  let limit = DEFAULT_LIMIT;

  for (const segment of segments(input)) {
    const colon = segment.indexOf(':');
    if (colon <= 0) {
      free.push(segment);
      continue;
    }

    const key = segment.slice(0, colon).toLowerCase();
    const value = segment.slice(colon + 1);

    if (!KEYS.has(key)) {
      ignored.push(segment);
      continue;
    }
    if (value.length === 0) {
      ignored.push(segment);
      continue;
    }

    switch (key) {
      case 'tag':
        tags.push(value.replace(/^#/, '').toLowerCase());
        break;
      case 'heading':
        headings.push(value.toLowerCase());
        break;
      case 'after':
      case 'before': {
        const date = normalizeDate(value);
        if (date === null) ignored.push(segment);
        else if (key === 'after') after = date;
        else before = date;
        break;
      }
      case 'mode':
        mode = value.toLowerCase();
        break;
      case 'in':
        if (PROVENANCES.has(value.toLowerCase() as Provenance)) {
          provenance = value.toLowerCase() as Provenance;
        } else {
          ignored.push(segment);
        }
        break;
      case 'limit': {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
        else ignored.push(segment);
        break;
      }
    }
  }

  return {
    terms: tokenizeQuery(free.join(' ')),
    tags,
    headings,
    after,
    before,
    mode,
    provenance,
    limit,
    ignored,
    raw: input.trim(),
  };
}

/** Accepts YYYY, YYYY-MM, or YYYY-MM-DD; widened to a full date so comparison is lexical. */
function normalizeDate(value: string): string | null {
  if (/^\d{4}$/.test(value)) return `${value}-01-01`;
  if (/^\d{4}-\d{2}$/.test(value)) return `${value}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}

/** Human-readable summary of what a query actually asked for, for groundedness reports. */
export function describeQuery(query: Query): string {
  const parts: string[] = [];
  if (query.terms.length > 0) parts.push(`terms [${query.terms.join(', ')}]`);
  if (query.tags.length > 0) parts.push(`tags [${query.tags.join(', ')}]`);
  if (query.headings.length > 0) parts.push(`headings [${query.headings.join(', ')}]`);
  if (query.after !== null) parts.push(`after ${query.after}`);
  if (query.before !== null) parts.push(`before ${query.before}`);
  if (query.mode !== null) parts.push(`mode ${query.mode}`);
  if (query.provenance !== null) parts.push(`in ${query.provenance}`);
  return parts.length === 0 ? 'nothing' : parts.join(', ');
}
