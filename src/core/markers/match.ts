import { normalizePhrase, type Legend, type LegendEntry, type Namespace } from './legend.ts';

/**
 * Recognizing a marker in something the user said (§5.6).
 *
 * The leading particle is what makes this safe: "that's a known error in the compiler" is a
 * sentence about a compiler, while "mark known error" is an annotation, and the difference is
 * a word the user chose specifically so ordinary speech would not trip it.
 *
 * The phrase has to end on a word boundary rather than a space. People type "mark known
 * error: the sign flip" and "mark known error — again", and dictation produces "mark known
 * error, the sign flip"; requiring a literal space silently filed all three under a shorter
 * marker. It also matches across flexible whitespace, because the phrase in the legend and
 * the phrase as typed will not always be spaced the same.
 *
 * Anything after the phrase is the marker's note. Markers fire silently and are never
 * confirmed, so the note is the only chance to say what was meant, and discarding it would
 * lose the one thing the user bothered to add.
 */

export interface MarkerMatch {
  readonly entry: LegendEntry;
  readonly note: string;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

const patterns = new WeakMap<LegendEntry, RegExp>();

function patternFor(entry: LegendEntry): RegExp {
  let pattern = patterns.get(entry);
  if (pattern === undefined) {
    const words = normalizePhrase(entry.phrase)
      .split(' ')
      .map((word) => word.replace(REGEX_SPECIAL, '\\$&'));
    // Word boundary, not whitespace: the note may be introduced by punctuation, or the
    // sentence may simply end. `marking` must not match `mark`.
    pattern = new RegExp(`^${words.join('\\s+')}(?![\\p{L}\\p{N}])`, 'iu');
    patterns.set(entry, pattern);
  }
  return pattern;
}

/**
 * Match an utterance against legend entries, optionally filtered by namespace.
 *
 * When `namespace` is provided, only entries of that namespace are considered. This lets
 * session.say() restrict to `'tag'` so control phrases never accidentally fire as markers,
 * and the voice adapter restrict to `'control'` for Tier 0 phrase matching.
 */
export function matchMarker(
  utterance: string,
  legend: Legend,
  namespace?: Namespace,
): MarkerMatch | null {
  const trimmed = utterance.trim();
  if (trimmed.length === 0) return null;

  // Longest phrase first, so a general marker cannot shadow a more specific one.
  let candidates = [...legend.entries];
  if (namespace !== undefined) {
    candidates = candidates.filter((e) => e.namespace === namespace);
  }
  candidates.sort((a, b) => b.normalized.length - a.normalized.length);

  for (const entry of candidates) {
    const match = patternFor(entry).exec(trimmed);
    if (match === null) continue;
    return { entry, note: stripLeadingPunctuation(trimmed.slice(match[0].length)) };
  }

  return null;
}

/**
 * Punctuation between the phrase and the note is not part of the note. "mark known error!" is
 * a marker with nothing added, not a marker whose note is an exclamation mark.
 */
function stripLeadingPunctuation(note: string): string {
  return note.replace(/^[\s:,.;!?…—–-]+/, '').trim();
}
