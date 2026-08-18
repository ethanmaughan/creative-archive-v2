import { CoreError } from '../errors.ts';
import type { ModelClient, ModelRequest } from './model-client.ts';

export interface OllamaOptions {
  readonly model: string;
  readonly host?: string;
  readonly timeoutMs?: number;
}

/**
 * Local model over Ollama's HTTP API (D-005).
 *
 * The archive stays sealed: nothing leaves the machine, and there is no account, key, or
 * meter behind this call. It is opt-in via CREATIVE_ARCHIVE_MODEL, so a daemon started
 * without configuration talks to nothing at all.
 */
export class OllamaModelClient implements ModelClient {
  readonly id: string;
  #model: string;
  #host: string;
  #timeoutMs: number;

  constructor(options: OllamaOptions) {
    this.#model = options.model;
    this.#host = options.host ?? 'http://127.0.0.1:11434';
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.id = `ollama:${options.model}`;
  }

  async complete(request: ModelRequest): Promise<string> {
    const body = {
      model: this.#model,
      stream: false,
      messages: [
        { role: 'system', content: request.systemPrompt },
        ...request.turns.map((turn) => ({
          role: turn.role === 'human' ? 'user' : 'assistant',
          content: turn.text,
        })),
      ],
    };

    let response: Response;
    try {
      response = await fetch(`${this.#host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new CoreError(
        'model_unreachable',
        `could not reach Ollama at ${this.#host}: ${(error as Error).message}`,
      );
    }

    if (!response.ok) {
      throw new CoreError(
        'model_error',
        `Ollama returned ${response.status}: ${(await response.text()).slice(0, 400)}`,
      );
    }

    const payload = (await response.json()) as { message?: { content?: string } };
    const content = payload.message?.content;
    if (typeof content !== 'string') {
      throw new CoreError('model_error', 'Ollama response had no message content');
    }
    return content.trim();
  }
}
