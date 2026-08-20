import type { TranscriptEntry } from '../session/transcript.ts';
import type { Legend, LegendEntry } from './legend.ts';

/**
 * What a marker covers (§5.6): markers scope **forward**.
 *
 * A tag opens a span and the next utterance boundary closes it. Backward-scoping would mean
 * inferring where the relevant passage began, which reintroduces exactly the guessing markers
 * exist to remove.
 *
 * Because a marker produces no agent turn, the entry after it is the user's own next
 * utterance — the thing being marked — rather than a reply that happened in between.
 */

export interface MarkedSpan {
  /** 1-based turn number of the marker row itself. */
  readonly markerTurn: number;
  /** 1-based turn number the marker covers, or null when it was the last thing said. */
  readonly coversTurn: number | null;
  readonly markerId: string;
  readonly note: string;
  readonly entry: LegendEntry | null;
}

export function markedSpans(
  entries: readonly TranscriptEntry[],
  legend: Legend | undefined,
): MarkedSpan[] {
  const spans: MarkedSpan[] = [];

  entries.forEach((entry, index) => {
    if (entry.role !== 'marker' || entry.markerId === undefined) return;

    // The next entry that is something said. A marker immediately followed by another marker
    // is two annotations on the same passage, not one annotation on the other marker.
    let covers: number | null = null;
    for (let ahead = index + 1; ahead < entries.length; ahead += 1) {
      if (entries[ahead]!.role === 'marker') continue;
      covers = ahead + 1;
      break;
    }

    spans.push({
      markerTurn: index + 1,
      coversTurn: covers,
      markerId: entry.markerId,
      note: entry.text,
      entry: legend?.entries.find((candidate) => candidate.id === entry.markerId) ?? null,
    });
  });

  return spans;
}

/** Turn numbers a marker speaks for. Derivation output for these is discarded (invariant 6). */
export function markedTurns(spans: readonly MarkedSpan[]): Set<number> {
  const turns = new Set<number>();
  for (const span of spans) {
    turns.add(span.markerTurn);
    if (span.coversTurn !== null) turns.add(span.coversTurn);
  }
  return turns;
}

/** Markers the legend routes to the shared error index (§5.4, §5.5 — one index, three sources). */
export function indexedSpans(spans: readonly MarkedSpan[]): MarkedSpan[] {
  return spans.filter((span) => span.entry?.writes.includes('error-index') === true);
}
