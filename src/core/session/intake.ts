import { z } from 'zod';
import type { ModelClient } from '../model/model-client.ts';
import type { Mode } from '../modes/mode.ts';

/**
 * Marks a completion request as intent extraction rather than conversation. The scripted
 * client keys off it so tests can drive intake deterministically without the core growing a
 * special case for fakes.
 */
export const INTENT_MARKER = '<<intake-intent>>';

export interface Intent {
  readonly mode: string | null;
  readonly title: string | null;
}

const IntentSchema = z.object({
  mode: z.string().nullable().catch(null),
  title: z.string().nullable().catch(null),
});

export function intentSystemPrompt(modes: readonly Mode[]): string {
  return [
    INTENT_MARKER,
    '',
    'Extract intent from one utterance. Reply with JSON only, no prose:',
    '',
    '  {"mode": <one of the ids below, or null>, "title": <short noun phrase, or null>}',
    '',
    'Modes:',
    ...modes.map((mode) => `  ${mode.id} — ${mode.label}`),
    '',
    'Use null for mode when the utterance does not clearly indicate one. Guessing is worse',
    'than asking: the mode decides what the agent may read and write, so a wrong guess is a',
    'scope error rather than an inconvenience.',
    '',
    'The title is the subject, not a summary of the sentence. No quotes, no trailing period.',
  ].join('\n');
}

/**
 * §5.1 steps 3–4: parse the first utterance for intent, then ask only for what is missing.
 * Questions are a fallback, not a protocol — the utterance usually carries the subject and
 * often the mode already ("I'm stuck on the Act II mission chapters").
 */
export async function resolveIntent(
  utterance: string,
  modes: readonly Mode[],
  model: ModelClient,
): Promise<Intent> {
  let raw: string;
  try {
    raw = await model.complete({
      systemPrompt: intentSystemPrompt(modes),
      turns: [{ role: 'human', text: utterance }],
    });
  } catch {
    // A model that is down must not cost the user their preamble. Fall through to asking.
    return { mode: null, title: null };
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { mode: null, title: null };

  let document: unknown;
  try {
    document = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { mode: null, title: null };
  }

  const parsed = IntentSchema.safeParse(document);
  if (!parsed.success) return { mode: null, title: null };

  const known = modes.some((mode) => mode.id === parsed.data.mode);
  const title = parsed.data.title?.trim();

  return {
    mode: known ? parsed.data.mode : null,
    title: title !== undefined && title.length > 0 ? title : null,
  };
}

/** Fallback title when intake produced none: the utterance, clipped at a word boundary. */
export function titleFromUtterance(utterance: string, limit = 60): string {
  const flat = utterance.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const clipped = flat.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > 20 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
