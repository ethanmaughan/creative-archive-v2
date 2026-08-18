import { connect, type Socket } from 'node:net';
import {
  encode,
  isEvent,
  takeLines,
  type Event,
  type Request,
  type ServerMessage,
} from '../../protocol/messages.ts';

export class CoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

/**
 * Client half of the wire protocol.
 *
 * Small on purpose: an adapter translates and nothing more (§2.2). Every decision this file
 * could make — what a mode means, whether an end needs confirming — belongs to the core, so
 * that a second adapter cannot make it differently.
 */
export class CoreClient {
  #socket: Socket;
  #nextId = 1;
  #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  #onEvent: (event: Event) => void = () => {};
  #buffer = '';

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#receive(chunk));
    socket.on('close', () => {
      for (const { reject } of this.#pending.values()) {
        reject(new CoreError('disconnected', 'the core closed the connection'));
      }
      this.#pending.clear();
    });
  }

  static connect(path: string): Promise<CoreClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        resolve(new CoreClient(socket));
      });
    });
  }

  onEvent(handler: (event: Event) => void): void {
    this.#onEvent = handler;
  }

  request<T = unknown>(request: Request): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#socket.write(encode({ id, ...request }));
    });
  }

  close(): void {
    this.#socket.end();
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    const { lines, rest } = takeLines(this.#buffer);
    this.#buffer = rest;

    for (const line of lines) {
      let message: ServerMessage;
      try {
        message = JSON.parse(line) as ServerMessage;
      } catch {
        continue;
      }

      if (isEvent(message)) {
        this.#onEvent(message);
        continue;
      }

      const pending = this.#pending.get(message.id);
      if (pending === undefined) continue;
      this.#pending.delete(message.id);

      if (message.ok) pending.resolve(message.result);
      else pending.reject(new CoreError(message.error.code, message.error.message));
    }
  }
}
