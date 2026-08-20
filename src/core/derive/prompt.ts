import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configRoot } from '../config/paths.ts';
import type { TranscriptEntry } from '../session/transcript.ts';

/**
 * The derivation prompt (§5.4), and the place §4.4's hard boundary is actually enforced.
 *
 * This prompt is composed from the derivation instructions and the transcript. It does not
 * include the personality fragment, and it does not include the agent's name — not as a
 * matter of the model behaving well, but because those strings never enter the request. That
 * is what makes derived structure personality-invariant: re-running this pass in a year
 * under a different preset composes the same prompt, so the archive cannot drift in a way no
 * amount of reprocessing could correct.
 *
 * The scripted client keys off the marker so derivation can be driven deterministically in
 * tests without the core growing a special case for fakes.
 */
export const DERIVE_MARKER = '<<derive>>';

export async function derivationSystemPrompt(
  configDir: string = configRoot(),
): Promise<string> {
  const instructions = await readFile(join(configDir, 'prompts', 'derive.md'), 'utf8');
  return `${DERIVE_MARKER}\n\n${instructions.trim()}`;
}

/**
 * The transcript as the model sees it: one numbered turn per entry.
 *
 * Numbering exists so citations can be resolved rather than trusted. Asking a model to
 * reproduce an ISO timestamp exactly invites a plausible near-miss that points at nothing;
 * a turn number is either in range or it is not, and the anchor is looked up here.
 */
export function numberTranscript(entries: readonly TranscriptEntry[]): string {
  return entries
    .map((entry, index) => {
      // Marker rows carry which marker fired: those are the user's own annotations, and the
      // pass is told not to restate what they already say (§5.4, derivation yields to markers).
      const role =
        entry.markerId === undefined ? entry.role : `${entry.role}:${entry.markerId}`;
      return `[${index + 1}] ${role}: ${entry.text}`;
    })
    .join('\n\n');
}
