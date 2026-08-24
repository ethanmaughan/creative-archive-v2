import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { ARCHIVE_INTERNAL_DIR, configRoot } from '../config/paths.ts';
import { ConfigInvalid } from '../errors.ts';
import type { FileStore } from '../storage/file-store.ts';

/**
 * The legend (§5.6): one versioned file, read by both the person and the agent.
 *
 * That shared file is what makes "we understand each other" a property of the system rather
 * than an assumption — and it is why the archive's own copy wins over the shipped default.
 * The vocabulary is the user's, it lives in their archive, and it is versioned with it, so
 * the language they are inventing survives their forgetting it.
 *
 * Two namespaces, kept distinct (§5.6):
 *
 *   tag     — annotation: records something (marker in transcript)
 *   control — session lifecycle, macros: does something (Tier 0, §2.3)
 *
 * The distinction is load-bearing: tags fire silently and are never confirmed. Control phrases
 * sound like commands and perform actions. Misfiring across namespaces behaves like the wrong
 * thing entirely.
 */

export const LEGEND_PATH = `${ARCHIVE_INTERNAL_DIR}/legend.yaml`;

const NAMESPACES = ['tag', 'control'] as const;

const SPANS = ['forward'] as const;

const DEFERRED_SPANS: Record<string, string> = {
  paired: 'paired open/close markers (§5.6), which need a close phrase and open-span state',
};

const WRITES = ['transcript', 'error-index'] as const;
const SAFETY = ['safe', 'confirm'] as const;
const CAPTURES = ['rest'] as const;

// ── Schemas ───────────────────────────────────────────────────────────────────

const BaseFields = z.object({
  phrase: z.string().min(2),
  namespace: z.string().min(1),
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
});

const TagSchema = BaseFields.extend({
  namespace: z.literal('tag'),
  span: z.string().min(1),
  writes: z.array(z.string().min(1)).min(1),
}).strict();

const ControlSchema = BaseFields.extend({
  namespace: z.literal('control'),
  safety: z.string().min(1),
  captures: z.string().min(1).optional(),
}).strict();

/** Loose schema for initial parsing — namespace-specific validation follows. */
const EntrySchema = z.union([TagSchema, ControlSchema]);

// ── Types ─────────────────────────────────────────────────────────────────────

export type Namespace = (typeof NAMESPACES)[number];
export type SpanBehavior = (typeof SPANS)[number];
export type WriteTarget = (typeof WRITES)[number];
export type Safety = (typeof SAFETY)[number];
export type Captures = (typeof CAPTURES)[number];

interface LegendEntryBase {
  readonly phrase: string;
  readonly normalized: string;
  readonly id: string;
}

export interface TagEntry extends LegendEntryBase {
  readonly namespace: 'tag';
  readonly span: SpanBehavior;
  readonly writes: readonly WriteTarget[];
}

export interface ControlEntry extends LegendEntryBase {
  readonly namespace: 'control';
  readonly safety: Safety;
  readonly captures?: Captures | undefined;
}

export type LegendEntry = TagEntry | ControlEntry;

export interface Legend {
  readonly source: string;
  readonly entries: readonly LegendEntry[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function tagEntries(legend: Legend): readonly TagEntry[] {
  return legend.entries.filter((e): e is TagEntry => e.namespace === 'tag');
}

export function controlEntries(legend: Legend): readonly ControlEntry[] {
  return legend.entries.filter((e): e is ControlEntry => e.namespace === 'control');
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export function parseLegend(raw: string, source: string): Legend {
  const document: unknown = parse(raw);
  if (!Array.isArray(document)) {
    throw new ConfigInvalid(source, 'expected a YAML list of legend entries');
  }

  const entries: LegendEntry[] = [];
  const seenIds = new Set<string>();
  const seenPhrases = new Set<string>();

  for (const [index, item] of document.entries()) {
    const parsed = EntrySchema.safeParse(item);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ConfigInvalid(source, `entry ${index + 1}: ${detail}`);
    }

    const entry = parsed.data;
    const where = `entry ${index + 1} ('${entry.id}')`;

    if (!(NAMESPACES as readonly string[]).includes(entry.namespace)) {
      throw new ConfigInvalid(source, `${where}: unknown namespace '${entry.namespace}'`);
    }

    const normalized = normalizePhrase(entry.phrase);
    if (seenIds.has(entry.id)) throw new ConfigInvalid(source, `${where}: duplicate id`);
    if (seenPhrases.has(normalized)) {
      throw new ConfigInvalid(source, `${where}: duplicate phrase '${entry.phrase}'`);
    }
    seenIds.add(entry.id);
    seenPhrases.add(normalized);

    if (entry.namespace === 'tag') {
      validateTagEntry(entry, where, source);
      entries.push({
        phrase: entry.phrase,
        normalized,
        namespace: 'tag',
        id: entry.id,
        span: entry.span as SpanBehavior,
        writes: entry.writes as WriteTarget[],
      });
    } else {
      validateControlEntry(entry as z.infer<typeof ControlSchema>, where, source);
      const control = entry as z.infer<typeof ControlSchema>;
      entries.push({
        phrase: entry.phrase,
        normalized,
        namespace: 'control',
        id: entry.id,
        safety: control.safety as Safety,
        ...(control.captures !== undefined ? { captures: control.captures as Captures } : {}),
      });
    }
  }

  return { source, entries };
}

function validateTagEntry(
  entry: z.infer<typeof TagSchema>,
  where: string,
  source: string,
): void {
  const deferredSpan = DEFERRED_SPANS[entry.span];
  if (deferredSpan !== undefined) {
    throw new ConfigInvalid(
      source,
      `${where}: span '${entry.span}' is not implemented yet — ${deferredSpan}`,
    );
  }
  if (!(SPANS as readonly string[]).includes(entry.span)) {
    throw new ConfigInvalid(source, `${where}: unknown span '${entry.span}'`);
  }

  for (const target of entry.writes) {
    if (!(WRITES as readonly string[]).includes(target)) {
      throw new ConfigInvalid(
        source,
        `${where}: unknown write target '${target}' (known: ${WRITES.join(', ')})`,
      );
    }
  }
  if (!entry.writes.includes('transcript')) {
    throw new ConfigInvalid(source, `${where}: every marker must write to the transcript`);
  }
}

function validateControlEntry(
  entry: z.infer<typeof ControlSchema>,
  where: string,
  source: string,
): void {
  if (!(SAFETY as readonly string[]).includes(entry.safety)) {
    throw new ConfigInvalid(
      source,
      `${where}: unknown safety '${entry.safety}' (known: ${SAFETY.join(', ')})`,
    );
  }
  if (
    entry.captures !== undefined &&
    !(CAPTURES as readonly string[]).includes(entry.captures)
  ) {
    throw new ConfigInvalid(
      source,
      `${where}: unknown captures '${entry.captures}' (known: ${CAPTURES.join(', ')})`,
    );
  }
}

/** The archive's own legend, falling back to the shipped default when it has none. */
export async function loadLegend(store: FileStore, configDir?: string): Promise<Legend> {
  if (await store.exists(LEGEND_PATH)) {
    return parseLegend(await store.read(LEGEND_PATH), LEGEND_PATH);
  }

  const shipped = join(configDir ?? configRoot(), 'legend.yaml');
  if (!existsSync(shipped)) {
    return { source: 'none', entries: [] };
  }
  return parseLegend(await readFile(shipped, 'utf8'), shipped);
}
