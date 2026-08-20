/**
 * The transcript format (§7.1, invariant 1).
 *
 * `transcript.md` is the append-only ground truth. It carries no frontmatter — metadata
 * lives in meta.yaml — which is what lets intake flush its scratch buffer into place with
 * a rename instead of a rewrite (§5.1). Nothing is ever prepended to this file.
 *
 * Both sides are recorded (D-004). Roles are fixed labels rather than the agent's name:
 * the name is a fact about the session and belongs in meta.yaml (§4.4), and a transcript
 * whose speaker labels changed with identity would not be comparable across sessions.
 *
 *     ## 2026-08-17T14:32:07.412Z human
 *
 *     I'm stuck on the Act II mission chapters.
 *
 *     ## 2026-08-17T14:32:11.019Z agent
 *
 *     Which chapters, and stuck how?
 */

export const TRANSCRIPT_FILE = 'transcript.md';

export const TRANSCRIPT_ROLES = ['human', 'agent', 'footnote', 'marker'] as const;

export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

export interface TranscriptEntry {
  readonly at: string;
  readonly role: TranscriptRole;
  readonly text: string;
  /**
   * Which legend entry fired, for `marker` rows only (§5.6).
   *
   * Markers live in the append-only layer because they are ground truth: a derivation pass
   * guessing "he sounded unsure here" is soft, and the user saying `mark known error` is not.
   * Putting them anywhere regenerable would make them the same kind of claim as a guess.
   */
  readonly markerId?: string;
}

const HEADER =
  /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (human|agent|footnote|marker)(?::([a-z0-9][a-z0-9-]*))?$/;

export function formatEntry(entry: TranscriptEntry): string {
  const role = entry.markerId === undefined ? entry.role : `${entry.role}:${entry.markerId}`;
  const text = entry.text.trim();
  // An entry with no body — a marker fired with nothing added — gets no empty paragraph.
  // The transcript is append-only, so a stray blank line is permanent, and this file is
  // meant to be read by a person.
  return text.length === 0
    ? `## ${entry.at} ${role}\n\n`
    : `## ${entry.at} ${role}\n\n${text}\n\n`;
}

/**
 * Parse a transcript. Tolerates a truncated tail: a process killed between writing a header
 * and writing its body leaves an entry with empty text, and that is a fact worth keeping
 * rather than an error worth throwing.
 */
export function parseTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let current: {
    at: string;
    role: TranscriptRole;
    markerId: string | undefined;
    lines: string[];
  } | null = null;

  const flush = (): void => {
    if (current === null) return;
    entries.push({
      at: current.at,
      role: current.role,
      text: current.lines.join('\n').trim(),
      ...(current.markerId === undefined ? {} : { markerId: current.markerId }),
    });
    current = null;
  };

  for (const line of raw.split('\n')) {
    const match = HEADER.exec(line);
    if (match) {
      flush();
      current = {
        at: match[1]!,
        role: match[2] as TranscriptRole,
        markerId: match[3],
        lines: [],
      };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  flush();

  return entries;
}
