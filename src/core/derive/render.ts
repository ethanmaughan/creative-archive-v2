import type { TranscriptEntry } from '../session/transcript.ts';

/**
 * Rendering the derived `session.md` from a mode's `session_template` (§3, "output shape").
 *
 * The template is finally consumed here; it has existed, existence-checked and unread, since
 * step 1. A placeholder the pass has nothing for is left standing rather than blanked, so a
 * template asking for something nobody produces is visible in the output instead of silently
 * dropped.
 */

export interface ResolvedHighlight {
  readonly deepLink: string;
  readonly why: string;
  readonly quote: string;
}

export interface ResolvedThread {
  readonly question: string;
  readonly why: string | null;
  readonly deepLink: string | null;
  /**
   * Where this came from. §5.4: markers are ground truth and derivation is the fallback, with
   * derived output "proposed at low confidence and queued for review" — so the two have to be
   * distinguishable in the file, not merged into one list of equal claims.
   */
  readonly source: 'marker' | 'derived';
  readonly markerId?: string;
}

export interface ResolvedOutlineEntry {
  readonly heading: string;
  readonly deepLink: string | null;
}

export interface DerivedContent {
  readonly title: string;
  readonly summary: string;
  readonly outline: readonly ResolvedOutlineEntry[];
  readonly highlights: readonly ResolvedHighlight[];
  readonly openThreads: readonly ResolvedThread[];
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/**
 * A leading HTML comment in a template explains the template to whoever edits it. It is not
 * part of the document, and copying it into the archive would put a note about how the tool
 * works into every set of minutes the user ever reads. Comments further down are left alone —
 * those are the author's.
 */
const LEADING_COMMENT = /^\s*<!--[\s\S]*?-->\s*/;

export function renderSessionMarkdown(template: string, content: DerivedContent): string {
  const values: Record<string, string> = {
    title: content.title,
    summary:
      content.summary.length > 0 ? content.summary : '_Nothing was settled in this session._',
    outline: renderOutline(content.outline),
    highlights: renderHighlights(content.highlights),
    open_threads: renderThreads(content.openThreads),
  };

  return template
    .replace(LEADING_COMMENT, '')
    .replace(PLACEHOLDER, (match, name: string) => values[name] ?? match);
}

/** Placeholders a template asked for that this pass does not produce. */
export function unresolvedPlaceholders(template: string): string[] {
  const known = new Set(['title', 'summary', 'outline', 'highlights', 'open_threads']);
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!known.has(name)) found.add(name);
  }
  return [...found];
}

function renderOutline(outline: readonly ResolvedOutlineEntry[]): string {
  if (outline.length === 0) return '_One continuous thread; no sections._';
  return outline
    .map((entry) =>
      entry.deepLink === null
        ? `- ${entry.heading}`
        : `- [${entry.heading}](${entry.deepLink})`,
    )
    .join('\n');
}

function renderHighlights(highlights: readonly ResolvedHighlight[]): string {
  if (highlights.length === 0) return '_None proposed._';
  return highlights
    .map(
      (highlight) =>
        // Whole turn, not an excerpt. A turn is the unit someone actually said; clipping it
        // would put words in the record that the source did not say in that order.
        `- [${highlight.why}](${highlight.deepLink})\n\n${highlight.quote.replace(/^/gm, '  > ')}`,
    )
    .join('\n\n');
}

function renderThreads(threads: readonly ResolvedThread[]): string {
  if (threads.length === 0) return '_Nothing left open._';

  // Markers first: they are what the user said at the time, and they are not proposals.
  const ordered = [
    ...threads.filter((thread) => thread.source === 'marker'),
    ...threads.filter((thread) => thread.source === 'derived'),
  ];

  return ordered
    .map((thread) => {
      const link = thread.deepLink === null ? '' : ` ([left here](${thread.deepLink}))`;
      const why = thread.why === null ? '' : ` — ${thread.why}`;
      if (thread.source === 'marker') {
        return `- **${thread.markerId ?? 'marked'}**: ${thread.question}${why}${link}`;
      }
      return `- ${thread.question}${why}${link} _(proposed)_`;
    })
    .join('\n');
}

/** The turn a citation points at, or null when the number was out of range. */
export function resolveTurn(
  entries: readonly TranscriptEntry[],
  turn: number | undefined,
): TranscriptEntry | null {
  if (turn === undefined || !Number.isInteger(turn)) return null;
  return entries[turn - 1] ?? null;
}
