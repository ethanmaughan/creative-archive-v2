import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * An append-only file handle (§7.1, invariant 1).
 *
 * Synchronous on purpose. A `WriteStream` would be faster and would also hold pending
 * bytes in a userland buffer, which is precisely the thing the invariant forbids — a
 * ninety-minute session lost to a crashed process is the failure that gets the tool
 * abandoned (§5.2). Every `append` reaches the OS before it returns.
 *
 * `sync` is separate because fsync is the expensive half. Callers fsync at utterance
 * boundaries, not per byte: a crash can then lose at most the utterance in flight, and
 * the cost is one flush per turn rather than one per token.
 */
export class AppendLog {
  #fd: number | null;
  readonly path: string;

  private constructor(fd: number, path: string) {
    this.#fd = fd;
    this.path = path;
  }

  static open(path: string): AppendLog {
    mkdirSync(dirname(path), { recursive: true });
    // 'a' is O_APPEND: every write lands at the current end of file, so a second writer
    // (or a recovered process re-opening the same transcript) cannot overwrite history.
    return new AppendLog(openSync(path, 'a'), path);
  }

  get isOpen(): boolean {
    return this.#fd !== null;
  }

  #handle(): number {
    if (this.#fd === null) {
      throw new Error(`append log '${this.path}' is closed`);
    }
    return this.#fd;
  }

  /** Write through to the OS. Returns once the bytes are out of this process. */
  append(text: string): void {
    const fd = this.#handle();
    const buffer = Buffer.from(text, 'utf8');
    let written = 0;
    // writeSync can be partial on a short write; loop until the buffer is drained.
    while (written < buffer.length) {
      written += writeSync(fd, buffer, written, buffer.length - written);
    }
  }

  /** Flush the OS page cache to disk. Call at utterance boundaries. */
  sync(): void {
    fsyncSync(this.#handle());
  }

  appendAndSync(text: string): void {
    this.append(text);
    this.sync();
  }

  close(): void {
    if (this.#fd === null) return;
    try {
      fsyncSync(this.#fd);
    } finally {
      closeSync(this.#fd);
      this.#fd = null;
    }
  }
}
