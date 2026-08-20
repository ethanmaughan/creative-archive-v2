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
 */

export const LEGEND_PATH = `${ARCHIVE_INTERNAL_DIR}/legend.yaml`;

/**
 * Only the tag namespace is implementable today. Control phrases — session lifecycle and
 * macros — *do* something rather than record something, and firing them is the Tier 0 phrase
 * registry (§2.3, build order step 6). A control entry that recorded instead of acting would
 * be the misfire across namespaces §5.6 warns about, so the loader refuses it by name.
 */
const NAMESPACES = ['tag'] as const;

const DEFERRED_NAMESPACES: Record<string, string> = {
  control: 'the Tier 0 phrase registry (§2.3, build order step 6)',
};

const SPANS = ['forward'] as const;

const DEFERRED_SPANS: Record<string, string> = {
  paired: 'paired open/close markers (§5.6), which need a close phrase and open-span state',
};

const WRITES = ['transcript', 'error-index'] as const;

const EntrySchema = z
  .object({
    phrase: z.string().min(2),
    namespace: z.string().min(1),
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    span: z.string().min(1),
    writes: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type Namespace = (typeof NAMESPACES)[number];
export type SpanBehavior = (typeof SPANS)[number];
export type WriteTarget = (typeof WRITES)[number];

export interface LegendEntry {
  readonly phrase: string;
  /** The phrase, normalized for matching: lowercase, single-spaced. */
  readonly normalized: string;
  readonly namespace: Namespace;
  readonly id: string;
  readonly span: SpanBehavior;
  readonly writes: readonly WriteTarget[];
}

export interface Legend {
  readonly source: string;
  readonly entries: readonly LegendEntry[];
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
}

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

    const deferredNamespace = DEFERRED_NAMESPACES[entry.namespace];
    if (deferredNamespace !== undefined) {
      throw new ConfigInvalid(
        source,
        `${where}: namespace '${entry.namespace}' is not implemented yet — it arrives with ${deferredNamespace}`,
      );
    }
    if (!(NAMESPACES as readonly string[]).includes(entry.namespace)) {
      throw new ConfigInvalid(source, `${where}: unknown namespace '${entry.namespace}'`);
    }

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
      // §5.6: markers write to the append-only layer. A marker that skipped the transcript
      // would be an annotation that lives only in the regenerable layer, which is the exact
      // distinction between a marker and a derivation guess.
      throw new ConfigInvalid(source, `${where}: every marker must write to the transcript`);
    }

    const normalized = normalizePhrase(entry.phrase);
    if (seenIds.has(entry.id)) throw new ConfigInvalid(source, `${where}: duplicate id`);
    if (seenPhrases.has(normalized)) {
      throw new ConfigInvalid(source, `${where}: duplicate phrase '${entry.phrase}'`);
    }
    seenIds.add(entry.id);
    seenPhrases.add(normalized);

    entries.push({
      phrase: entry.phrase,
      normalized,
      namespace: entry.namespace as Namespace,
      id: entry.id,
      span: entry.span as SpanBehavior,
      writes: entry.writes as WriteTarget[],
    });
  }

  return { source, entries };
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
