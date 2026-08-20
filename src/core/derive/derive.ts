import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Archive } from '../archive/archive.ts';
import { CoreError } from '../errors.ts';
import type { ModelClient } from '../model/model-client.ts';
import type { Legend } from '../markers/legend.ts';
import { indexedSpans, markedSpans, markedTurns } from '../markers/spans.ts';
import type { Mode } from '../modes/mode.ts';
import { readMeta, writeMeta } from '../session/meta.ts';
import { sessionDir } from '../session/session-id.ts';
import { TRANSCRIPT_FILE, parseTranscript } from '../session/transcript.ts';
import { assertScopeWrite, ScopedFileStore } from '../storage/scoped-file-store.ts';
import { derivationSystemPrompt, numberTranscript } from './prompt.ts';
import {
  renderSessionMarkdown,
  resolveTurn,
  unresolvedPlaceholders,
  type DerivedContent,
  type ResolvedHighlight,
  type ResolvedOutlineEntry,
  type ResolvedThread,
} from './render.ts';

/**
 * The post-session derivation pass (§5.4) — the minutes.
 *
 * Runs over a committed transcript and produces the derived layer beside it. Everything it
 * writes is disposable and regenerable, which is the licence for it to be re-run across the
 * whole archive when the prompts improve (§5.4) and the reason a wrong result is cheap.
 *
 * It never touches `transcript.md`. That is the split §7.1 exists to protect, and it is what
 * makes reprocessing safe years later.
 *
 * **Derivation runs over the whole transcript.** Invariant 6 also requires it to *yield* to
 * markers where a marker covers a span — but markers (§5.6) do not exist yet, so there is
 * nothing to yield to and no yielding logic here. Running everywhere is the half that is
 * meaningful today, and it is the half that was deliberate: a marker you forgot to say is
 * indistinguishable from nothing worth marking, so a pass that only ran over marked regions
 * could never catch the session where you got tired and stopped tagging.
 */

export const SESSION_FILE = 'session.md';

const DerivedSchema = z.object({
  title: z.string().trim().min(1).optional(),
  summary: z.string().trim().catch(''),
  tags: z.array(z.string()).catch([]),
  outline: z
    .array(
      z.object({ heading: z.string().trim().min(1), turns: z.array(z.number()).catch([]) }),
    )
    .catch([]),
  highlights: z.array(z.object({ turn: z.number(), why: z.string().trim().min(1) })).catch([]),
  open_threads: z
    .array(
      z.object({
        question: z.string().trim().min(1),
        why: z.string().trim().optional(),
        turn: z.number().optional(),
      }),
    )
    .catch([]),
});

export interface DerivationOptions {
  readonly archive: Archive;
  readonly sessionId: string;
  /**
   * The mode whose `session_template` shapes the output, and whose write scope is checked.
   * Passed in rather than read from meta.yaml: a session recovered from a buffer that never
   * reached intake has no mode (D-009), and picking one on its behalf is a caller's decision.
   */
  readonly mode: Mode;
  readonly model: ModelClient;
  /**
   * The annotation vocabulary (§5.6). Without it, marker rows in the transcript are still
   * visible but the pass cannot tell which ones the legend routes to the error index, so it
   * yields to them without contributing them.
   */
  readonly legend?: Legend;
  readonly configDir?: string;
  readonly now?: () => Date;
}

export interface DerivationReport {
  readonly sessionId: string;
  readonly outcome: 'derived' | 'unparseable' | 'empty-transcript';
  readonly wrote: readonly string[];
  readonly tags: readonly string[];
  readonly highlights: number;
  readonly openThreads: number;
  /** Citations the model made to turns that do not exist. Visible, not silently dropped. */
  readonly droppedReferences: number;
  /** Derived items discarded because a marker already speaks for that turn (invariant 6). */
  readonly yieldedToMarkers: number;
  /** Open threads contributed by markers rather than proposed by the pass. */
  readonly markerThreads: number;
  readonly unresolvedPlaceholders: readonly string[];
  readonly model: string;
  readonly derivedAt: string | null;
}

export async function deriveSession(options: DerivationOptions): Promise<DerivationReport> {
  const { archive, sessionId, mode, model } = options;
  const now = options.now ?? ((): Date => new Date());

  const transcriptPath = `${sessionDir(sessionId)}/${TRANSCRIPT_FILE}`;
  if (!(await archive.store.exists(transcriptPath))) {
    throw new CoreError('no_such_session', `session '${sessionId}' has no transcript`);
  }

  const entries = parseTranscript(await archive.store.read(transcriptPath));
  const base: Omit<DerivationReport, 'outcome' | 'wrote' | 'derivedAt'> = {
    sessionId,
    tags: [],
    highlights: 0,
    openThreads: 0,
    droppedReferences: 0,
    yieldedToMarkers: 0,
    markerThreads: 0,
    unresolvedPlaceholders: [],
    model: model.id,
  };

  if (entries.length === 0) {
    return { ...base, outcome: 'empty-transcript', wrote: [], derivedAt: null };
  }

  const systemPrompt = await derivationSystemPrompt(options.configDir);
  const raw = await model.complete({
    systemPrompt,
    turns: [{ role: 'human', text: numberTranscript(entries) }],
  });

  const parsed = parseDerived(raw);
  if (parsed === null) {
    // No output rather than bad output. The derived layer being absent is a state the system
    // already handles — it is the state every session is in before this pass runs.
    return { ...base, outcome: 'unparseable', wrote: [], derivedAt: null };
  }

  // Invariant 6: the pass runs over the whole transcript, and where a marker covers a span its
  // output for that span is discarded. Enforced here rather than asked for in the prompt —
  // "please do not restate the marker" is not a guarantee, and this is.
  const spans = markedSpans(entries, options.legend);
  const marked = markedTurns(spans);
  let yieldedToMarkers = 0;
  const yields = (turn: number | undefined): boolean => {
    if (turn === undefined || !marked.has(turn)) return false;
    yieldedToMarkers += 1;
    return true;
  };

  let droppedReferences = 0;
  const noteDropped = <T>(value: T | null): T | null => {
    if (value === null) droppedReferences += 1;
    return value;
  };

  const outline: ResolvedOutlineEntry[] = parsed.outline.map((entry) => {
    const first = entry.turns.length > 0 ? resolveTurn(entries, entry.turns[0]) : null;
    if (entry.turns.length > 0 && first === null) droppedReferences += 1;
    return {
      heading: entry.heading,
      deepLink: first === null ? null : `${TRANSCRIPT_FILE}#${first.at}`,
    };
  });

  const highlights: ResolvedHighlight[] = parsed.highlights.flatMap((highlight) => {
    if (yields(highlight.turn)) return [];
    const entry = noteDropped(resolveTurn(entries, highlight.turn));
    if (entry === null) return [];
    return [
      { deepLink: `${TRANSCRIPT_FILE}#${entry.at}`, why: highlight.why, quote: entry.text },
    ];
  });

  const derivedThreads: ResolvedThread[] = parsed.open_threads.flatMap((thread) => {
    if (yields(thread.turn)) return [];
    const entry = thread.turn === undefined ? null : resolveTurn(entries, thread.turn);
    if (thread.turn !== undefined && entry === null) droppedReferences += 1;
    return [
      {
        question: thread.question,
        why: thread.why ?? null,
        deepLink: entry === null ? null : `${TRANSCRIPT_FILE}#${entry.at}`,
        source: 'derived' as const,
      },
    ];
  });

  // §5.4 / §5.5: open threads and the error index are one index written from three sources.
  // Markers are the first of them, and they arrive as fact rather than as a proposal.
  const markerThreads: ResolvedThread[] = indexedSpans(spans).map((span) => {
    const covered = span.coversTurn === null ? null : resolveTurn(entries, span.coversTurn);
    const marker = resolveTurn(entries, span.markerTurn);
    return {
      question: span.note.length > 0 ? span.note : (covered?.text ?? 'marked with no note'),
      why: null,
      deepLink: `${TRANSCRIPT_FILE}#${(covered ?? marker)?.at ?? ''}`,
      source: 'marker' as const,
      markerId: span.markerId,
    };
  });

  const openThreads: ResolvedThread[] = [...markerThreads, ...derivedThreads];

  const meta = await readMeta(archive.store, sessionId);
  const content: DerivedContent = {
    title: parsed.title ?? meta.title,
    summary: parsed.summary,
    outline,
    highlights,
    openThreads,
  };

  const sessionPath = `${sessionDir(sessionId)}/${SESSION_FILE}`;
  assertScopeWrite(mode.scope, mode.id, sessionPath);
  const scoped = new ScopedFileStore(archive.store, mode.scope, mode.id);

  const template =
    mode.sessionTemplatePath === null
      ? DEFAULT_TEMPLATE
      : await readFile(mode.sessionTemplatePath, 'utf8');

  const derivedAt = now().toISOString();
  await scoped.write(sessionPath, renderSessionMarkdown(template, content));

  const tags = normalizeTags(parsed.tags);
  await writeMeta(scoped, {
    ...meta,
    title: content.title,
    tags,
    derived_at: derivedAt,
    derived_by: model.id,
  });

  return {
    sessionId,
    outcome: 'derived',
    wrote: [sessionPath, `${sessionDir(sessionId)}/meta.yaml`],
    tags,
    highlights: highlights.length,
    openThreads: openThreads.length,
    droppedReferences,
    yieldedToMarkers,
    markerThreads: markerThreads.length,
    unresolvedPlaceholders: unresolvedPlaceholders(template),
    model: model.id,
    derivedAt,
  };
}

function parseDerived(raw: string): z.infer<typeof DerivedSchema> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let document: unknown;
  try {
    document = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }

  const parsed = DerivedSchema.safeParse(document);
  return parsed.success ? parsed.data : null;
}

function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of tags) {
    const normalized = tag.trim().replace(/^#/, '').toLowerCase();
    if (normalized.length > 0) seen.add(normalized);
  }
  return [...seen];
}

/** Used only when a mode declares no template. Modes that ship with one never reach this. */
const DEFAULT_TEMPLATE = `# {{title}}

## Summary

{{summary}}

## Outline

{{outline}}

## Open threads

{{open_threads}}

## Proposed highlights

{{highlights}}
`;
