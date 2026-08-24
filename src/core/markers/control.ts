import type { ControlEntry, Legend } from './legend.ts';
import { matchMarker } from './match.ts';

/**
 * Tier 0 phrase matching (§2.3): deterministic control-phrase recognition.
 *
 * Control phrases *do* something rather than *record* something. They are matched in the
 * adapter before the utterance reaches the core, so the core never sees them as conversation.
 */

export interface ControlMatch {
  readonly entry: ControlEntry;
  /** Text captured after the phrase. Empty when the entry has no `captures` field. */
  readonly argument: string;
}

export function matchControl(utterance: string, legend: Legend): ControlMatch | null {
  const match = matchMarker(utterance, legend, 'control');
  if (match === null) return null;

  const entry = match.entry as ControlEntry;
  const argument = entry.captures === 'rest' ? match.note : '';
  return { entry, argument };
}
