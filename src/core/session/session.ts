import { randomBytes } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import type { Archive } from '../archive/archive.ts';
import { ARCHIVE_INTERNAL_DIR } from '../config/paths.ts';
import { SessionStateError } from '../errors.ts';
import type { Identity } from '../identity/identity.ts';
import type { ModelClient, ModelTurn } from '../model/model-client.ts';
import { assertToolAllowed, type Mode } from '../modes/mode.ts';
import type { ArchiveIndex } from '../retrieval/index.ts';
import { retrieve, type RetrievalResult } from '../retrieval/retrieve.ts';
import { buildSystemPrompt } from '../prompt/compose.ts';
import type { AppendHandle } from '../storage/file-store.ts';
import { ScopedFileStore, assertScopeWrite } from '../storage/scoped-file-store.ts';
import { resolveIntent, titleFromUtterance } from './intake.ts';
import { writeMeta, type EndReason, type SessionMeta } from './meta.ts';
import { clearOpenSession, writeOpenSession } from './open-session.ts';
import { formatStamp, newSessionId, sessionDir } from './session-id.ts';
import { TRANSCRIPT_FILE, formatEntry, type TranscriptRole } from './transcript.ts';

export const SCRATCH_DIR = `${ARCHIVE_INTERNAL_DIR}/scratch`;

/** §5.1 step 2: one open prompt. Not a form, and not a menu. */
export const GREETING = "What's going on?";

export type SessionState = 'buffering' | 'open' | 'ending' | 'closed' | 'aborted';

export interface SessionDeps {
  readonly archive: Archive;
  readonly identity: Identity;
  readonly model: ModelClient;
  readonly modes: readonly Mode[];
  /** Pre-selected mode. When absent, intake resolves it from the first utterance (§5.1). */
  readonly mode?: Mode;
  /**
   * Snapshot of the archive index (§8). A snapshot is correct rather than convenient: the
   * only thing changing during a session is this session's own transcript, and those turns
   * are already in the model's context. The registry rebuilds between sessions.
   *
   * Absent means no retrieval, and the prompt says so instead of letting the agent guess.
   */
  readonly index?: ArchiveIndex;
  readonly now?: () => Date;
  readonly configDir?: string;
}

export interface SayResult {
  readonly reply: string;
  readonly committed: boolean;
  readonly sessionId: string | null;
}

export interface EndRequest {
  readonly token: string;
  readonly reason: EndReason;
  readonly question: string;
}

const ScratchSidecar = z.object({ started_at: z.string(), pid: z.number().int() }).strict();

/**
 * One session, from the first buffered word to the confirmed close (§5).
 *
 * The ordering that matters: buffering starts before anything is known — before the mode,
 * before the folder, before the title. Intake resolves scope afterward and the buffer is
 * *renamed* into place rather than rewritten, so the preamble the user typed while still
 * annoyed is the same bytes that end up as the head of the transcript.
 */
export class Session {
  #deps: SessionDeps;
  #state: SessionState = 'buffering';
  #log: AppendHandle;
  #scratchId: string;
  #mode: Mode | null;
  #scoped: ScopedFileStore | null = null;
  #id: string | null = null;
  #startedAt: string;
  #committedAt: string | null = null;
  #title = '';
  #turns: ModelTurn[] = [];
  #endToken: string | null = null;
  #endReason: EndReason | null = null;
  #lastRetrieval: RetrievalResult | null = null;

  private constructor(
    deps: SessionDeps,
    scratchId: string,
    log: AppendHandle,
    startedAt: string,
  ) {
    this.#deps = deps;
    this.#scratchId = scratchId;
    this.#log = log;
    this.#startedAt = startedAt;
    this.#mode = deps.mode ?? null;
  }

  get state(): SessionState {
    return this.#state;
  }

  get id(): string | null {
    return this.#id;
  }

  get mode(): Mode | null {
    return this.#mode;
  }

  get title(): string {
    return this.#title;
  }

  /** Archive-relative path of the file currently being appended to. */
  get transcriptPath(): string {
    return this.#id === null
      ? `${SCRATCH_DIR}/${this.#scratchId}.md`
      : `${sessionDir(this.#id)}/${TRANSCRIPT_FILE}`;
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  /**
   * §5.1 step 1: buffering begins immediately, to a scratch file. Nothing is known yet —
   * not the mode, not the subject — and the buffer exists so that not knowing costs nothing.
   */
  static async begin(deps: SessionDeps): Promise<Session> {
    const startedAt = (deps.now?.() ?? new Date()).toISOString();
    const scratchId = `pending-${formatStamp(new Date(startedAt))}-${randomBytes(2).toString('hex')}`;

    await deps.archive.store.write(
      `${SCRATCH_DIR}/${scratchId}.yaml`,
      stringify({ started_at: startedAt, pid: process.pid }),
    );

    const log = deps.archive.store.openAppend(`${SCRATCH_DIR}/${scratchId}.md`);
    const session = new Session(deps, scratchId, log, startedAt);
    session.#appendEntry('agent', GREETING);
    session.#turns.push({ role: 'agent', text: GREETING });
    return session;
  }

  #appendEntry(role: TranscriptRole, text: string): void {
    this.#log.appendAndSync(formatEntry({ at: this.#now().toISOString(), role, text }));
  }

  /** A turn from the user. Drives intake while buffering, conversation once open. */
  async say(text: string): Promise<SayResult> {
    if (this.#state !== 'buffering' && this.#state !== 'open' && this.#state !== 'ending') {
      throw new SessionStateError(`cannot speak into a session that is ${this.#state}`);
    }
    if (this.#state === 'ending') {
      throw new SessionStateError('session is awaiting an end confirmation');
    }

    this.#appendEntry('human', text);
    this.#turns.push({ role: 'human', text });

    let committed = false;
    if (this.#state === 'buffering') {
      committed = await this.#tryCommit(text);
      if (!committed) {
        const question = this.#scopeQuestion();
        this.#appendEntry('agent', question);
        this.#turns.push({ role: 'agent', text: question });
        return { reply: question, committed: false, sessionId: null };
      }
    }

    const reply = await this.#respond(text);
    return { reply, committed, sessionId: this.#id };
  }

  /**
   * Retrieval for one turn, keyed on what the user just said.
   *
   * The model is not given tool calling in this build, so retrieval is automatic rather
   * than model-invoked (D-013). The alternative — no retrieval until tool calling exists —
   * would leave §3.1 groundedness unenforceable, since an agent that cannot search cannot
   * honestly report what the archive does or does not hold.
   */
  #retrieveFor(utterance: string): RetrievalResult | null {
    const index = this.#deps.index;
    if (index === undefined) return null;

    const mode = this.#requireMode();
    if (!mode.tools.includes('retrieve')) return null;

    this.#lastRetrieval = retrieve(index, mode, utterance);
    return this.#lastRetrieval;
  }

  /** What the last turn actually searched, for a caller that wants to show its work. */
  get lastRetrieval(): RetrievalResult | null {
    return this.#lastRetrieval;
  }

  /** The `retrieve` tool, invoked directly — the adapter's way of inspecting the index. */
  search(queryText: string): RetrievalResult {
    const index = this.#deps.index;
    if (index === undefined) {
      throw new SessionStateError('this archive has no index (retrieval is unavailable)');
    }
    const mode = this.#requireMode();
    assertToolAllowed(mode, 'retrieve');
    return retrieve(index, mode, queryText);
  }

  async #respond(utterance: string): Promise<string> {
    const mode = this.#requireMode();
    const retrieval = this.#retrieveFor(utterance);

    const { prompt } = await buildSystemPrompt({
      archiveRoot: this.#deps.archive.root,
      mode,
      identity: this.#deps.identity,
      retrievalAvailable: this.#deps.index !== undefined,
      ...(retrieval !== null ? { retrieval } : {}),
      ...(this.#deps.configDir !== undefined ? { configDir: this.#deps.configDir } : {}),
    });

    const reply = await this.#deps.model.complete({ systemPrompt: prompt, turns: this.#turns });
    this.#appendEntry('agent', reply);
    this.#turns.push({ role: 'agent', text: reply });
    return reply;
  }

  #scopeQuestion(): string {
    return `Which mode — ${this.#deps.modes.map((mode) => mode.id).join(', ')}?`;
  }

  /** §5.1 steps 3–5. Extract what is present, ask only for what is missing, then commit. */
  async #tryCommit(utterance: string): Promise<boolean> {
    let mode = this.#mode ?? this.#matchModeLiterally(utterance);
    let title: string | null = null;

    if (mode === null) {
      const intent = await resolveIntent(utterance, this.#deps.modes, this.#deps.model);
      mode = this.#deps.modes.find((candidate) => candidate.id === intent.mode) ?? null;
      title = intent.title;
    }

    if (mode === null) return false;

    await this.commit(mode, title ?? titleFromUtterance(utterance));
    return true;
  }

  /** A bare "tutor" answering the scope question resolves without consulting a model. */
  #matchModeLiterally(utterance: string): Mode | null {
    const flat = utterance.trim().toLowerCase();
    return (
      this.#deps.modes.find(
        (mode) => mode.id.toLowerCase() === flat || mode.label.toLowerCase() === flat,
      ) ?? null
    );
  }

  /**
   * Scope has resolved: create the folder, flush the buffer into it, write metadata.
   *
   * The flush is a rename. Rewriting the buffer through a second file handle would mean the
   * committed transcript is a *copy* of the ground truth rather than the ground truth, and
   * would give a crash mid-flush a window in which neither file is whole.
   */
  async commit(mode: Mode, title: string): Promise<string> {
    if (this.#state !== 'buffering') {
      throw new SessionStateError(`cannot commit a session that is ${this.#state}`);
    }

    const id = newSessionId(this.#now());
    const dir = sessionDir(id);
    const transcript = `${dir}/${TRANSCRIPT_FILE}`;

    // Prove the mode may write here before touching anything (§3, D-007).
    assertScopeWrite(mode.scope, mode.id, transcript);
    assertScopeWrite(mode.scope, mode.id, `${dir}/meta.yaml`);

    const store = this.#deps.archive.store;
    this.#log.close();
    await store.mkdir(dir);
    await store.rename(`${SCRATCH_DIR}/${this.#scratchId}.md`, transcript);
    await store.remove(`${SCRATCH_DIR}/${this.#scratchId}.yaml`);

    this.#mode = mode;
    this.#id = id;
    this.#title = title;
    this.#committedAt = this.#now().toISOString();
    this.#scoped = new ScopedFileStore(store, mode.scope, mode.id);
    this.#log = this.#scoped.openAppend(transcript);
    this.#state = 'open';

    await writeMeta(this.#scoped, this.#meta());
    await writeOpenSession(store, {
      session_id: id,
      opened_at: this.#committedAt,
      pid: process.pid,
    });

    return id;
  }

  /** §5.2: an explicit footnote, written to the transcript at its timestamp. */
  async footnote(text: string): Promise<void> {
    if (this.#state !== 'open') {
      throw new SessionStateError('footnotes require a committed session');
    }
    assertToolAllowed(this.#requireMode(), 'footnote');
    this.#appendEntry('footnote', text);
  }

  /**
   * §5.3: every end confirms, without exception. The phrase registry that will eventually
   * drive this will fire mid-sentence, and an idle timer cannot tell thinking from leaving.
   */
  requestEnd(reason: EndReason = 'confirmed'): EndRequest {
    if (this.#state !== 'open') {
      throw new SessionStateError(`cannot end a session that is ${this.#state}`);
    }
    assertToolAllowed(this.#requireMode(), 'session_end');

    this.#endToken = randomBytes(8).toString('hex');
    this.#endReason = reason;
    this.#state = 'ending';

    return {
      token: this.#endToken,
      reason,
      question: reason === 'idle' ? 'Still there? End the session?' : 'End the session?',
    };
  }

  cancelEnd(): void {
    if (this.#state !== 'ending') return;
    this.#endToken = null;
    this.#endReason = null;
    this.#state = 'open';
  }

  async confirmEnd(token: string): Promise<SessionMeta> {
    if (this.#state !== 'ending' || this.#endToken === null) {
      throw new SessionStateError('no end is awaiting confirmation');
    }
    if (token !== this.#endToken) {
      throw new SessionStateError('end confirmation token does not match');
    }

    this.#log.close();
    this.#state = 'closed';

    const meta = this.#meta({
      endedAt: this.#now().toISOString(),
      endedBy: this.#endReason ?? 'confirmed',
    });
    await writeMeta(this.#requireScoped(), meta);
    await clearOpenSession(this.#deps.archive.store);
    return meta;
  }

  /** §5.1: abort before commit discards the buffer. After commit there is nothing to abort. */
  async abort(): Promise<void> {
    if (this.#state !== 'buffering') {
      throw new SessionStateError(`cannot abort a session that is ${this.#state} — a committed session ends with a confirm, not an abort (§5.1)`);
    }
    this.#log.close();
    const store = this.#deps.archive.store;
    await store.remove(`${SCRATCH_DIR}/${this.#scratchId}.md`);
    await store.remove(`${SCRATCH_DIR}/${this.#scratchId}.yaml`);
    this.#state = 'aborted';
  }

  #meta(ended?: { endedAt: string; endedBy: EndReason }): SessionMeta {
    if (this.#id === null || this.#committedAt === null) {
      throw new SessionStateError('session has not committed');
    }
    return {
      id: this.#id,
      title: this.#title,
      mode: this.#mode?.id ?? null,
      agent_name: this.#deps.identity.name,
      personality: this.#deps.identity.personality,
      started_at: this.#startedAt,
      committed_at: this.#committedAt,
      ended_at: ended?.endedAt ?? null,
      ended_by: ended?.endedBy ?? null,
      recovered: false,
      links: [],
    };
  }

  #requireMode(): Mode {
    if (this.#mode === null) throw new SessionStateError('no mode is active');
    return this.#mode;
  }

  #requireScoped(): ScopedFileStore {
    if (this.#scoped === null) throw new SessionStateError('session has not committed');
    return this.#scoped;
  }
}

export { ScratchSidecar };
export const parseScratchSidecar = (raw: string): z.infer<typeof ScratchSidecar> | null => {
  const parsed = ScratchSidecar.safeParse(parse(raw) ?? {});
  return parsed.success ? parsed.data : null;
};
