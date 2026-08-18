import { INTENT_MARKER } from '../session/intake.ts';
import type { ModelClient, ModelRequest } from './model-client.ts';

export interface ScriptedOptions {
  /** Conversational replies, consumed in order; the last one repeats once exhausted. */
  readonly replies?: readonly string[];
  /** What intake extraction should return. Omit to make intake fall through to asking. */
  readonly intent?: { mode?: string | null; title?: string | null };
}

/**
 * The default model client, and the one the tests run against.
 *
 * Deterministic and personality-blind on purpose: the personality-invariance check (§4.4)
 * is only meaningful if the layer underneath cannot be the thing that varies. It also means
 * a bare `pnpm test` — or a daemon started without configuring a model — talks to nothing
 * outside this process.
 */
export class ScriptedModelClient implements ModelClient {
  readonly id = 'scripted';
  #replies: readonly string[];
  #intent: ScriptedOptions['intent'];
  #calls = 0;
  #conversationalCalls = 0;

  constructor(options: ScriptedOptions = {}) {
    this.#replies = options.replies ?? ['Noted.'];
    this.#intent = options.intent;
  }

  get callCount(): number {
    return this.#calls;
  }

  async complete(request: ModelRequest): Promise<string> {
    this.#calls += 1;

    if (request.systemPrompt.includes(INTENT_MARKER)) {
      return JSON.stringify({
        mode: this.#intent?.mode ?? null,
        title: this.#intent?.title ?? null,
      });
    }

    const index = Math.min(this.#conversationalCalls, this.#replies.length - 1);
    this.#conversationalCalls += 1;
    return this.#replies[index] ?? 'Noted.';
  }
}
