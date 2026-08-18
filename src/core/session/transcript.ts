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

export const TRANSCRIPT_ROLES = ['human', 'agent', 'footnote'] as const;

export type TranscriptRole = (typeof TRANSCRIPT_ROLES)[number];

export interface TranscriptEntry {
  readonly at: string;
  readonly role: TranscriptRole;
  readonly text: string;
}

const HEADER = /^## (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (human|agent|footnote)$/;

export function formatEntry(entry: TranscriptEntry): string {
  return `## ${entry.at} ${entry.role}\n\n${entry.text.trim()}\n\n`;
}

/**
 * Parse a transcript. Tolerates a truncated tail: a process killed between writing a header
 * and writing its body leaves an entry with empty text, and that is a fact worth keeping
 * rather than an error worth throwing.
 */
export function parseTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let current: { at: string; role: TranscriptRole; lines: string[] } | null = null;

  const flush = (): void => {
    if (current === null) return;
    entries.push({ at: current.at, role: current.role, text: current.lines.join('\n').trim() });
    current = null;
  };

  for (const line of raw.split('\n')) {
    const match = HEADER.exec(line);
    if (match) {
      flush();
      current = { at: match[1]!, role: match[2] as TranscriptRole, lines: [] };
      continue;
    }
    if (current !== null) current.lines.push(line);
  }
  flush();

  return entries;
}
