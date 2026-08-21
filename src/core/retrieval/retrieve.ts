import type { Mode } from '../modes/mode.ts';
import { scopePermitsRead } from '../storage/scoped-file-store.ts';
import type { Provenance } from './document.ts';
import type { ArchiveIndex, MatchMode } from './index.ts';
import { describeQuery, parseQuery } from './query.ts';

/**
 * The `retrieve` tool.
 *
 * Two jobs beyond running the query. First, mode read scope is applied to results (§3) —
 * retrieval is a read, and a read outside scope is a scope violation whether it arrives
 * through the file store or through an index. Second, every answer carries what was
 * searched (§3.1), because *not in the archive* and *not found by this query* are different
 * claims and only the first is a statement about the archive. A gap report without the
 * search behind it is an assertion; with it, a bad index is diagnosable.
 */

export interface RetrievedSpan {
  readonly deepLink: string;
  readonly title: string;
  readonly heading: string | null;
  readonly provenance: Provenance;
  readonly date: string | null;
  readonly text: string;
  readonly score: number;
  readonly matched: readonly string[];
}

/**
 * §3.2 retrieval precedence for tutor mode: the user's own notes and prior sessions, then
 * ingested reference material, and no third tier. `reference` is unreachable until ingest
 * lands (step 4) — recorded as unavailable rather than quietly never matching.
 */
export type Tier = 'own' | 'reference';

export interface SearchedRecord {
  readonly query: string;
  readonly terms: readonly string[];
  readonly filters: string;
  readonly ignored: readonly string[];
  readonly scope: readonly string[];
  /** Paths held out of this mode regardless of scope — §5.5's partition, where it applies. */
  readonly denied: readonly string[];
  readonly generation: number;
  readonly documentsInArchive: number;
  readonly candidateSpans: number;
  readonly matchMode: MatchMode;
  readonly tier: Tier | null;
  readonly referenceTierAvailable: boolean;
  /** Whether the live session's own transcript was held out of its own search. */
  readonly excludedCurrentSession: boolean;
}

export interface RetrievalResult {
  readonly spans: RetrievedSpan[];
  readonly searched: SearchedRecord;
  /** True when the search ran and found nothing — the input to a §3.1 gap report. */
  readonly empty: boolean;
}

export interface RetrieveOptions {
  /**
   * Held out of the search. A live session passes its own transcript: the index is built from
   * the files as they are now, so the utterance being answered is *in* it, and a query taken
   * from that utterance matches it perfectly. Retrieval was handing the agent the question it
   * had just been asked, ranked above the material that actually answered it.
   *
   * Nothing is lost — those turns are already in the model's context.
   */
  readonly exclude?: (path: string) => boolean;
}

export function retrieve(
  index: ArchiveIndex,
  mode: Mode,
  queryText: string,
  options: RetrieveOptions = {},
): RetrievalResult {
  const query = parseQuery(queryText);
  const exclude = options.exclude;
  const permit = (path: string): boolean =>
    scopePermitsRead(mode.scope, path) && (exclude === undefined || !exclude(path));

  // §3.2's tiers are not yet a distinction: tier 1 is the user's own notes and prior
  // sessions, which is everything the index currently holds, and tier 2 is ingested
  // material that does not exist until step 4. So there is no tier filter here — writing
  // one now would mean a branch that always takes the same path, tested against nothing.
  // What is recorded instead is which tier answered, and that tier 2 was unavailable.
  const outcome = index.search(query, permit);

  // Spans are returned whole. A span is already bounded by something a human chose — a
  // heading, or one conversational turn — and clipping mid-sentence produces a quotation
  // that says something the source did not. If a real archive turns out to have spans large
  // enough to crowd the context, that is a number to derive from that archive rather than
  // guess at here; `limit` is the bound that exists today.
  const spans = outcome.hits.map((hit) => ({
    deepLink: hit.span.deepLink,
    title: hit.document.title,
    heading: hit.span.heading,
    provenance: hit.document.provenance,
    date: hit.document.date,
    text: hit.span.text,
    score: Number(hit.score.toFixed(4)),
    matched: hit.matched,
  }));

  return {
    spans,
    searched: {
      query: query.raw,
      terms: query.terms,
      filters: describeQuery(query),
      ignored: query.ignored,
      scope: mode.scope.read,
      denied: mode.scope.deny ?? [],
      generation: index.generation,
      documentsInArchive: index.documents,
      candidateSpans: outcome.candidates,
      matchMode: outcome.matchMode,
      tier: spans.length > 0 ? 'own' : null,
      // Flips when ingest lands. Until then, tutor's fall-through to tier 2 has nowhere to
      // fall, and saying so is the difference between "no reference material covers this"
      // and "there is no reference material".
      referenceTierAvailable: false,
      excludedCurrentSession: exclude !== undefined,
    },
    empty: spans.length === 0,
  };
}

/**
 * Prose the agent can put in front of the user, built from the same record the caller sees.
 * Mode-appropriate phrasing lives in the mode prompt fragments (§3.1); this is the evidence
 * those reports are required to carry.
 */
export function describeSearch(record: SearchedRecord): string {
  const parts = [
    `searched ${record.documentsInArchive} document(s) for ${record.filters}`,
    record.denied.length === 0
      ? `scope ${record.scope.join(', ')}`
      : `scope ${record.scope.join(', ')} minus ${record.denied.join(', ')}`,
    `index generation ${record.generation}`,
  ];
  if (record.candidateSpans === 0 && record.terms.length > 0) {
    parts.push('no span passed the filters, so the terms were never tested');
  }
  if (record.matchMode === 'any') {
    parts.push('no span matched every term — results are partial matches');
  }
  if (record.ignored.length > 0) {
    parts.push(`ignored unrecognized ${record.ignored.join(', ')}`);
  }
  if (record.excludedCurrentSession) {
    parts.push('this session was held out of its own search');
  }
  return parts.join('; ');
}
