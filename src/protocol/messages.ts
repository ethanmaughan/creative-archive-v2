import { z } from 'zod';

/**
 * The wire contract between the core and an adapter (D-001).
 *
 * Newline-delimited JSON, deliberately transport-agnostic. Step 1 carries it over a Unix
 * domain socket — no port to allocate, no HTTP framework, and filesystem permissions do the
 * access control for free. A browser cannot open a UDS, so if a windowed client ever
 * attaches this gains a loopback bridge; nothing in these shapes would change.
 *
 * Nothing here mentions audio. The voice adapter (steps 5–6) speaks these same messages —
 * that is what "the core has no knowledge of audio" (invariant 2) means in practice.
 */

export const PERSONALITY = z.enum(['plain', 'warm', 'dry', 'socratic', 'expansive']);

export const RequestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('attach'),
    archive: z.string().min(1),
    mode: z.string().optional(),
  }),
  z.object({ type: z.literal('modes.list') }),
  z.object({ type: z.literal('identity.get') }),
  z.object({
    type: z.literal('identity.set'),
    name: z.string().min(1).max(120).optional(),
    personality: PERSONALITY.optional(),
  }),
  z.object({ type: z.literal('session.begin'), mode: z.string().optional() }),
  z.object({ type: z.literal('session.say'), text: z.string() }),
  z.object({ type: z.literal('session.footnote'), text: z.string().min(1) }),
  z.object({ type: z.literal('session.end') }),
  z.object({ type: z.literal('session.end.confirm'), token: z.string().min(1) }),
  z.object({ type: z.literal('session.end.cancel') }),
  z.object({ type: z.literal('session.abort') }),
  z.object({ type: z.literal('session.status') }),
  z.object({ type: z.literal('shutdown') }),
]);

export type Request = z.infer<typeof RequestSchema>;

export const EnvelopeSchema = z
  .object({ id: z.number().int().nonnegative() })
  .and(RequestSchema);

export type Envelope = z.infer<typeof EnvelopeSchema>;

export interface OkResponse {
  readonly id: number;
  readonly ok: true;
  readonly result: unknown;
}

export interface ErrorResponse {
  readonly id: number;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export type Response = OkResponse | ErrorResponse;

/** Unsolicited server pushes. Step 1 has exactly one: the idle end prompt (§5.3). */
export interface Event {
  readonly event: 'session.confirm_required';
  readonly payload: {
    readonly token: string;
    readonly reason: string;
    readonly question: string;
  };
}

export type ServerMessage = Response | Event;

export function isEvent(message: ServerMessage): message is Event {
  return 'event' in message;
}

export function encode(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/** Split a growing buffer into complete lines, returning the unconsumed remainder. */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.filter((line) => line.trim().length > 0), rest };
}
