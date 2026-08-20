import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { openArchive, type Archive } from '../archive/archive.ts';
import { socketPath } from '../config/paths.ts';
import { CoreError, SessionStateError } from '../errors.ts';
import { loadIdentity, saveIdentity, type Identity } from '../identity/identity.ts';
import type { ModelClient } from '../model/model-client.ts';
import { resolveModelClient } from '../model/resolve.ts';
import { listModes, loadMode, type Mode } from '../modes/mode.ts';
import { IndexRegistry } from '../retrieval/registry.ts';
import { recoverArchive } from '../session/recovery.ts';
import { GREETING, Session } from '../session/session.ts';
import {
  EnvelopeSchema,
  encode,
  takeLines,
  type Envelope,
  type ServerMessage,
} from '../../protocol/messages.ts';

export interface DaemonOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly model?: ModelClient;
  readonly idleMs?: number;
  readonly log?: (message: string) => void;
}

interface Connection {
  readonly socket: Socket;
  archive: Archive | null;
  identity: Identity | null;
  mode: Mode | null;
  session: Session | null;
  idleTimer: NodeJS.Timeout | null;
}

const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * The headless core, listening (D-001).
 *
 * One connection owns at most one session, and one archive holds at most one live session
 * across the daemon — the open-session pointer is a single file per archive, and two
 * writers would make its meaning ambiguous exactly when it matters (§5.3).
 */
export class DaemonServer {
  readonly path: string;
  #server: Server;
  #env: NodeJS.ProcessEnv;
  #model: ModelClient;
  #idleMs: number;
  #log: (message: string) => void;
  #connections = new Set<Connection>();
  /**
   * The one session that is currently live, anywhere.
   *
   * Not a set keyed by archive: the limit is not that two sessions would collide on one
   * archive's files, it is that there is one person here. Two conversations at once about
   * different things is not a thing a human does, on one archive or two.
   *
   * It is also what keeps recovery safe. Recovery promotes or deletes whatever it finds in
   * the scratch directory (D-009), so running it while a session is mid-intake would eat
   * the buffer being written. Attach consults this before recovering.
   */
  #liveSession: { readonly archiveRoot: string; readonly connection: Connection } | null = null;
  #indexes = new IndexRegistry();
  #modes: Mode[] = [];

  constructor(options: DaemonOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#model = options.model ?? resolveModelClient(this.#env);
    this.#idleMs = options.idleMs ?? readIdleMs(this.#env);
    this.#log = options.log ?? ((): void => {});
    this.path = socketPath(this.#env);
    this.#server = createServer((socket) => this.#accept(socket));
  }

  async listen(): Promise<void> {
    this.#modes = await listModes();
    mkdirSync(dirname(this.path), { recursive: true });

    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.path, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });

    this.#log(`listening on ${this.path} (model: ${this.#model.id})`);
  }

  async close(): Promise<void> {
    for (const connection of this.#connections) {
      this.#clearIdle(connection);
      connection.socket.destroy();
    }
    this.#connections.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    try {
      unlinkSync(this.path);
    } catch {
      // Already gone; nothing to clean up.
    }
  }

  #accept(socket: Socket): void {
    const connection: Connection = {
      socket,
      archive: null,
      identity: null,
      mode: null,
      session: null,
      idleTimer: null,
    };
    this.#connections.add(connection);

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const { lines, rest } = takeLines(buffer);
      buffer = rest;
      for (const line of lines) void this.#dispatch(connection, line);
    });

    socket.on('close', () => {
      this.#clearIdle(connection);
      // An abandoned session still holds its transcript's file descriptor. Nothing frees
      // it on garbage collection, so it has to be released here or the daemon leaks one
      // per dropped client.
      connection.session?.abandon();
      connection.session = null;
      this.#forgetLiveSession(connection);
      this.#connections.delete(connection);
    });

    socket.on('error', () => socket.destroy());
  }

  #send(connection: Connection, message: ServerMessage): void {
    if (!connection.socket.destroyed) connection.socket.write(encode(message));
  }

  async #dispatch(connection: Connection, line: string): Promise<void> {
    // Recover the id before validating the rest: a client whose request was malformed is
    // still waiting on that id, and answering id 0 would leave it waiting forever.
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (error) {
      this.#send(connection, {
        id: 0,
        ok: false,
        error: { code: 'bad_json', message: (error as Error).message },
      });
      return;
    }

    const id =
      typeof raw === 'object' &&
      raw !== null &&
      typeof (raw as { id?: unknown }).id === 'number'
        ? (raw as { id: number }).id
        : 0;

    let envelope: Envelope;
    try {
      envelope = EnvelopeSchema.parse(raw);
    } catch (error) {
      this.#send(connection, {
        id,
        ok: false,
        error: { code: 'bad_request', message: (error as Error).message },
      });
      return;
    }

    try {
      const result = await this.#handle(connection, envelope);
      this.#send(connection, { id: envelope.id, ok: true, result });
    } catch (error) {
      const code = error instanceof CoreError ? error.code : 'internal';
      this.#send(connection, {
        id: envelope.id,
        ok: false,
        error: { code, message: (error as Error).message },
      });
    }
  }

  async #handle(connection: Connection, request: Envelope): Promise<unknown> {
    switch (request.type) {
      case 'attach':
        return this.#attach(connection, request.archive, request.mode);

      case 'modes.list':
        return this.#modes.map((mode) => ({
          id: mode.id,
          label: mode.label,
          tools: mode.tools,
          scope: mode.scope,
        }));

      case 'identity.get':
        return this.#requireIdentity(connection);

      case 'identity.set': {
        const archive = this.#requireArchive(connection);
        const current = this.#requireIdentity(connection);
        const next: Identity = {
          name: request.name ?? current.name,
          personality: request.personality ?? current.personality,
        };
        await saveIdentity(archive.store, next);
        connection.identity = next;
        return next;
      }

      case 'session.begin': {
        const archive = this.#requireArchive(connection);
        if (connection.session !== null && isLive(connection.session)) {
          throw new SessionStateError('this connection already has a session open');
        }
        if (this.#liveSession !== null) {
          throw new SessionStateError(
            `a session is already open on ${this.#liveSession.archiveRoot} — one conversation ` +
              `at a time, because there is one of you`,
          );
        }

        const modeId = request.mode ?? connection.mode?.id;
        const mode = modeId === undefined ? undefined : await loadMode(modeId);

        connection.session = await Session.begin({
          archive,
          identity: this.#requireIdentity(connection),
          model: this.#model,
          modes: this.#modes,
          index: await this.#indexes.get(archive),
          ...(mode !== undefined ? { mode } : {}),
        });
        this.#liveSession = { archiveRoot: archive.root, connection };
        this.#touchIdle(connection);

        return {
          state: connection.session.state,
          mode: connection.session.mode?.id ?? null,
          greeting: GREETING,
        };
      }

      case 'session.say': {
        const session = this.#requireSession(connection);
        const result = await session.say(request.text);
        this.#touchIdle(connection);
        return { ...result, state: session.state, mode: session.mode?.id ?? null };
      }

      case 'session.footnote': {
        const session = this.#requireSession(connection);
        await session.footnote(request.text);
        this.#touchIdle(connection);
        return { recorded: true };
      }

      case 'session.search': {
        const session = this.#requireSession(connection);
        this.#touchIdle(connection);
        return session.search(request.query);
      }

      case 'index.status': {
        const archive = this.#requireArchive(connection);
        const index = this.#indexes.peek(archive.root);
        return {
          stats: index?.stats ?? null,
          stale: this.#indexes.isStale(archive.root),
        };
      }

      case 'index.rebuild': {
        const archive = this.#requireArchive(connection);
        this.#indexes.markStale(archive.root);
        return (await this.#indexes.get(archive)).stats;
      }

      case 'session.end': {
        const session = this.#requireSession(connection);
        this.#clearIdle(connection);
        return session.requestEnd('confirmed');
      }

      case 'session.end.confirm': {
        const archive = this.#requireArchive(connection);
        const session = this.#requireSession(connection);
        const meta = await session.confirmEnd(request.token);
        // A finished session is archive content (§1): mark the index stale so the next
        // search can find what was just said.
        this.#indexes.markStale(archive.root);
        this.#releaseSession(connection);
        return meta;
      }

      case 'session.end.cancel': {
        this.#requireSession(connection).cancelEnd();
        this.#touchIdle(connection);
        return { state: 'open' };
      }

      case 'session.abort': {
        const session = this.#requireSession(connection);
        await session.abort();
        this.#releaseSession(connection);
        return { state: session.state };
      }

      case 'session.status': {
        const session = connection.session;
        return {
          archive: connection.archive?.root ?? null,
          identity: connection.identity,
          state: session?.state ?? null,
          sessionId: session?.id ?? null,
          mode: session?.mode?.id ?? connection.mode?.id ?? null,
          title: session?.title ?? null,
          transcript: session?.transcriptPath ?? null,
          model: this.#model.id,
          lastSearch: session?.lastRetrieval?.searched ?? null,
        };
      }

      case 'shutdown':
        setTimeout(() => void this.close(), 10);
        return { closing: true };
    }
  }

  async #attach(connection: Connection, root: string, modeId?: string): Promise<unknown> {
    const archive = await openArchive(root, this.#env);
    const identity = await loadIdentity(archive.store);

    // §5.3: recovery runs at attach, before any session can open. A scratch buffer
    // belonging to a live session is indistinguishable from an orphaned one, so this is
    // the only safe moment to look.
    const recovery =
      this.#liveSession?.archiveRoot === archive.root
        ? { crashedSessions: [], promotedBuffers: [], discardedBuffers: [] }
        : await recoverArchive(archive, { identity });

    connection.archive = archive;
    connection.identity = identity;
    connection.mode = modeId === undefined ? null : await loadMode(modeId);

    // Built here, after recovery, so a session promoted out of a crashed buffer is
    // searchable in the very session that recovered it.
    const index = await this.#indexes.get(archive);

    return {
      archive: archive.root,
      identity,
      mode: connection.mode?.id ?? null,
      model: this.#model.id,
      modes: this.#modes.map((mode) => mode.id),
      recovery,
      index: index.stats,
    };
  }

  #releaseSession(connection: Connection): void {
    this.#clearIdle(connection);
    this.#forgetLiveSession(connection);
    connection.session = null;
  }

  #forgetLiveSession(connection: Connection): void {
    if (this.#liveSession?.connection === connection) this.#liveSession = null;
  }

  /** §5.3 idle path: prompt to confirm, never close on the timer alone. */
  #touchIdle(connection: Connection): void {
    this.#clearIdle(connection);
    if (this.#idleMs <= 0) return;

    connection.idleTimer = setTimeout(() => {
      const session = connection.session;
      if (session === null || session.state !== 'open') return;
      try {
        const request = session.requestEnd('idle');
        this.#send(connection, { event: 'session.confirm_required', payload: request });
      } catch {
        // The session moved on between the timer firing and this callback; nothing to do.
      }
    }, this.#idleMs);
    connection.idleTimer.unref();
  }

  #clearIdle(connection: Connection): void {
    if (connection.idleTimer !== null) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = null;
    }
  }

  #requireArchive(connection: Connection): Archive {
    if (connection.archive === null) {
      throw new CoreError('not_attached', 'attach to an archive first');
    }
    return connection.archive;
  }

  #requireIdentity(connection: Connection): Identity {
    if (connection.identity === null) {
      throw new CoreError('not_attached', 'attach to an archive first');
    }
    return connection.identity;
  }

  #requireSession(connection: Connection): Session {
    if (connection.session === null) {
      throw new SessionStateError('no session is open');
    }
    return connection.session;
  }
}

function isLive(session: Session): boolean {
  return (
    session.state === 'buffering' || session.state === 'open' || session.state === 'ending'
  );
}

function readIdleMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CREATIVE_ARCHIVE_IDLE_MS;
  if (raw === undefined) return DEFAULT_IDLE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_IDLE_MS;
}
