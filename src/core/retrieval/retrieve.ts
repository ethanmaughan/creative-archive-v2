import type { Mode } from '../modes/mode.ts';
import { matchesAnyGlob } from '../storage/glob.ts';
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

/** How much of a span is returned. A long transcript turn must not eat the context. */
export const SPAN_CHARS = 600;

export interface RetrievedSpan {
  readonly deepLink: string;
  readonly title: string;
  readonly heading: string | null;
  readonly provenance: Provenance;
  readonly date: string | null;
  readonly text: string;
  readonly truncated: boolean;
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
  readonly generation: number;
  readonly documentsInArchive: number;
  readonly candidateSpans: number;
  readonly matchMode: MatchMode;
  readonly tier: Tier | null;
  readonly referenceTierAvailable: boolean;
}

export interface RetrievalResult {
  readonly spans: RetrievedSpan[];
  readonly searched: SearchedRecord;
  /** True when the search ran and found nothing — the input to a §3.1 gap report. */
  readonly empty: boolean;
}

export function retrieve(index: ArchiveIndex, mode: Mode, queryText: string): RetrievalResult {
  const query = parseQuery(queryText);
  const permit = (path: string): boolean => matchesAnyGlob(mode.scope.read, path);

  // §3.2's tiers are not yet a distinction: tier 1 is the user's own notes and prior
  // sessions, which is everything the index currently holds, and tier 2 is ingested
  // material that does not exist until step 4. So there is no tier filter here — writing
  // one now would mean a branch that always takes the same path, tested against nothing.
  // What is recorded instead is which tier answered, and that tier 2 was unavailable.
  const outcome = index.search(query, permit);

  const spans = outcome.hits.map((hit) => {
    const text =
      hit.span.text.length > SPAN_CHARS ? hit.span.text.slice(0, SPAN_CHARS) : hit.span.text;
    return {
      deepLink: hit.span.deepLink,
      title: hit.document.title,
      heading: hit.span.heading,
      provenance: hit.document.provenance,
      date: hit.document.date,
      text,
      truncated: text.length < hit.span.text.length,
      score: Number(hit.score.toFixed(4)),
      matched: hit.matched,
    };
  });

  return {
    spans,
    searched: {
      query: query.raw,
      terms: query.terms,
      filters: describeQuery(query),
      ignored: query.ignored,
      scope: mode.scope.read,
      generation: index.generation,
      documentsInArchive: index.documents,
      candidateSpans: outcome.candidates,
      matchMode: outcome.matchMode,
      tier: spans.length > 0 ? 'own' : null,
      // Flips when ingest lands. Until then, tutor's fall-through to tier 2 has nowhere to
      // fall, and saying so is the difference between "no reference material covers this"
      // and "there is no reference material".
      referenceTierAvailable: false,
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
    `scope ${record.scope.join(', ')}`,
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
  return parts.join('; ');
}
