/**
 * What the index holds (§8).
 *
 * Retrieval returns **spans**, never documents. §8's constraint is explicit: "retrieve
 * top-ranked spans across the archive", never "load the archive" — an hour of speech is a
 * large amount of text, and a long session in a mature archive would otherwise exhaust
 * context. Every span therefore carries a deep link back to where it came from, and the
 * caller is expected to follow it rather than ask for more.
 */

/**
 * Where a document came from. Ingested material carries its provenance through retrieval
 * (§5.5) so it never surfaces as though it were something concluded in conversation, and
 * tutor mode's retrieval tiers (§3.2) are expressed directly in these values.
 *
 * §5.5: ingested material carries its provenance through retrieval so it never surfaces as
 * though it were something concluded in conversation. That is the same reason a session turn
 * and a note are distinguishable — where a claim came from changes what it is.
 */
export type Provenance = 'note' | 'session' | 'ingest';

export interface Span {
  /** Stable within a document: a heading slug, or a transcript entry's timestamp. */
  readonly anchor: string;
  readonly heading: string | null;
  readonly text: string;
  /** `path#anchor` — what a caller follows instead of asking for the whole document. */
  readonly deepLink: string;
  readonly line: number;
}

export interface IndexedDocument {
  readonly path: string;
  readonly provenance: Provenance;
  readonly title: string;
  /** ISO date (YYYY-MM-DD) for range queries; null when the document carries no date. */
  readonly date: string | null;
  readonly tags: readonly string[];
  /** Session metadata (§7), null for ordinary notes. */
  readonly mode: string | null;
  readonly agent: string | null;
  readonly spans: readonly Span[];
}

/** GitHub-style heading slug: lowercase, spaces to dashes, punctuation dropped. */
export function headingSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export function deepLink(path: string, anchor: string): string {
  return anchor.length === 0 ? path : `${path}#${anchor}`;
}
