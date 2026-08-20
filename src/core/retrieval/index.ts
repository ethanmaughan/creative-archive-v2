import type { FileStore } from '../storage/file-store.ts';
import type { IndexedDocument, Span } from './document.ts';
import type { Query } from './query.ts';
import { scanArchive } from './scan.ts';
import { tokenize } from './tokenize.ts';

/**
 * The structural index (§8 phase 1), in process and built from the files.
 *
 * No database (D-005). The index is derived, so it is rebuilt at attach rather than
 * persisted — delete nothing, lose nothing. That also means every ranking decision here is
 * one you can read, which is §8's stated reason for going structural before semantic: when
 * a query returns the wrong thing you can see exactly why. `SearchHit.matched` and
 * `SearchOutcome.matchMode` exist for precisely that.
 *
 * Semantic retrieval is phase 2 and is deliberately absent.
 */

export interface SearchHit {
  readonly document: IndexedDocument;
  readonly span: Span;
  readonly score: number;
  /** Which query terms actually hit this span. The audit trail for a surprising result. */
  readonly matched: readonly string[];
}

export type MatchMode = 'all' | 'any' | 'filter-only';

export interface SearchOutcome {
  readonly hits: SearchHit[];
  /**
   * `all` — every term matched. `any` — nothing matched all terms, so the search was
   * relaxed; a report should say so, because a partial match presented as a full one is a
   * confident wrong answer. `filter-only` — the query carried no free text.
   */
  readonly matchMode: MatchMode;
  /** Spans left after filters, before ranking. Distinguishes "filtered out" from "no match". */
  readonly candidates: number;
}

export interface IndexStats {
  readonly generation: number;
  readonly documents: number;
  readonly spans: number;
  readonly tokens: number;
  readonly filesRead: number;
  readonly skipped: readonly string[];
  readonly builtAt: string;
  readonly buildMs: number;
}

interface Entry {
  readonly document: IndexedDocument;
  readonly span: Span;
}

export class ArchiveIndex {
  readonly stats: IndexStats;
  #entries: Entry[];
  /** token → span position → term frequency */
  #postings: Map<string, Map<number, number>>;

  private constructor(
    entries: Entry[],
    postings: Map<string, Map<number, number>>,
    stats: IndexStats,
  ) {
    this.#entries = entries;
    this.#postings = postings;
    this.stats = stats;
  }

  get generation(): number {
    return this.stats.generation;
  }

  get documents(): number {
    return this.stats.documents;
  }

  static async build(store: FileStore, previous?: ArchiveIndex): Promise<ArchiveIndex> {
    const startedAt = Date.now();
    const scan = await scanArchive(store);

    const entries: Entry[] = [];
    const postings = new Map<string, Map<number, number>>();

    for (const document of scan.documents) {
      for (const span of document.spans) {
        const position = entries.length;
        entries.push({ document, span });

        for (const token of tokenize(span.text)) {
          let bucket = postings.get(token);
          if (bucket === undefined) {
            bucket = new Map<number, number>();
            postings.set(token, bucket);
          }
          bucket.set(position, (bucket.get(position) ?? 0) + 1);
        }
      }
    }

    return new ArchiveIndex(entries, postings, {
      generation: (previous?.generation ?? 0) + 1,
      documents: scan.documents.length,
      spans: entries.length,
      tokens: postings.size,
      filesRead: scan.filesRead,
      skipped: scan.skipped,
      builtAt: new Date().toISOString(),
      buildMs: Date.now() - startedAt,
    });
  }

  /**
   * Ranked spans, never whole documents (§8).
   *
   * `permit` is how mode read scope reaches retrieval (§3). It is applied *before* ranking
   * and before the limit, so an out-of-scope document cannot consume a result slot and
   * cannot shift the scores of the documents a mode is allowed to see.
   */
  search(query: Query, permit?: (path: string) => boolean): SearchOutcome {
    const allowed = this.#applyFilters(query, permit);
    const candidates = allowed.size;

    if (query.terms.length === 0) {
      const hits = [...allowed]
        .map((position) => ({
          document: this.#entries[position]!.document,
          span: this.#entries[position]!.span,
          score: 1,
          matched: [] as string[],
        }))
        .sort(byRecencyThenPath)
        .slice(0, query.limit);
      return { hits, matchMode: 'filter-only', candidates };
    }

    const scored = this.#score(query, allowed);
    const complete = scored.filter((hit) => hit.matched.length === query.terms.length);

    // Relaxing is visible in the outcome rather than hidden in the ranking: a span matching
    // one of four terms is a different claim about the archive than one matching all four.
    const chosen = complete.length > 0 ? complete : scored;
    const matchMode: MatchMode = complete.length > 0 ? 'all' : 'any';

    return {
      hits: chosen
        .sort((a, b) => b.score - a.score || byRecencyThenPath(a, b))
        .slice(0, query.limit),
      matchMode,
      candidates,
    };
  }

  #applyFilters(query: Query, permit?: (path: string) => boolean): Set<number> {
    const allowed = new Set<number>();

    this.#entries.forEach((entry, position) => {
      const { document, span } = entry;

      if (permit !== undefined && !permit(document.path)) return;
      if (query.provenance !== null && document.provenance !== query.provenance) return;
      if (query.mode !== null && document.mode !== query.mode) return;
      if (query.after !== null && (document.date === null || document.date < query.after))
        return;
      if (query.before !== null && (document.date === null || document.date > query.before))
        return;

      if (query.tags.length > 0) {
        const has = query.tags.every((tag) => document.tags.includes(tag));
        if (!has) return;
      }

      if (query.headings.length > 0) {
        const heading = (span.heading ?? '').toLowerCase();
        const matches = query.headings.some((wanted) => heading.includes(wanted));
        if (!matches) return;
      }

      allowed.add(position);
    });

    return allowed;
  }

  #score(query: Query, allowed: Set<number>): SearchHit[] {
    const totals = new Map<number, { score: number; matched: string[] }>();

    for (const term of query.terms) {
      const bucket = this.#postings.get(term);
      if (bucket === undefined) continue;

      // Rare terms carry more signal than common ones. Plain idf, computed over spans.
      const idf = Math.log(1 + this.#entries.length / bucket.size);

      for (const [position, frequency] of bucket) {
        if (!allowed.has(position)) continue;
        let total = totals.get(position);
        if (total === undefined) {
          total = { score: 0, matched: [] };
          totals.set(position, total);
        }
        // Sub-linear in frequency: a span repeating a word ten times is not ten times the
        // answer, and without this a long transcript turn outranks a precise note.
        total.score += (1 + Math.log(frequency)) * idf;
        total.matched.push(term);
      }
    }

    return [...totals].map(([position, total]) => ({
      document: this.#entries[position]!.document,
      span: this.#entries[position]!.span,
      score: total.score,
      matched: total.matched,
    }));
  }

  /** Every indexed document, for callers that need the corpus rather than a ranking. */
  listDocuments(): IndexedDocument[] {
    const seen = new Map<string, IndexedDocument>();
    for (const entry of this.#entries) seen.set(entry.document.path, entry.document);
    return [...seen.values()];
  }
}

function byRecencyThenPath(a: SearchHit, b: SearchHit): number {
  const dateA = a.document.date ?? '';
  const dateB = b.document.date ?? '';
  if (dateA !== dateB) return dateB.localeCompare(dateA);
  if (a.document.path !== b.document.path)
    return a.document.path.localeCompare(b.document.path);
  return a.span.line - b.span.line;
}
