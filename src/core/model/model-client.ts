/**
 * The model seam.
 *
 * One primitive — text in, text out — because that is all step 1 needs and every extra
 * method would be an interface nobody has validated yet. Tool calling, streaming, and
 * structured output arrive when a step actually requires them.
 */
export interface ModelTurn {
  readonly role: 'human' | 'agent';
  readonly text: string;
}

export interface ModelRequest {
  readonly systemPrompt: string;
  readonly turns: readonly ModelTurn[];
}

export interface ModelClient {
  readonly id: string;
  complete(request: ModelRequest): Promise<string>;
}
