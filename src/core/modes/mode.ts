import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { configRoot } from '../config/paths.ts';
import { ConfigInvalid, CoreError } from '../errors.ts';
import type { Scope } from '../storage/scoped-file-store.ts';

/** Tools the core actually implements today. */
export const IMPLEMENTED_TOOLS = ['footnote', 'session_end'] as const;

/**
 * Tools the spec assigns to a mode manifest that a later step implements. Naming one is a
 * hard error rather than a no-op: a manifest that declares `retrieve` and gets silently
 * ignored is a mode whose behavior does not match its declaration, which is the failure
 * the declaration exists to prevent.
 */
export const DEFERRED_TOOLS: Record<string, string> = {
  retrieve: 'structural retrieval (build order step 2)',
};

const ScopeSchema = z.object({
  read: z.array(z.string().min(1)),
  write: z.array(z.string().min(1)),
});

const ModeSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    prompt_fragment: z.string().min(1),
    scope: ScopeSchema,
    tools: z.array(z.string().min(1)),
    session_template: z.string().min(1).optional(),
  })
  .strict();

export interface Mode {
  readonly id: string;
  readonly label: string;
  readonly promptFragmentPath: string;
  readonly scope: Scope;
  readonly tools: readonly string[];
  /**
   * Shape of the derived session.md (§3). Existence-checked at load so a typo fails loudly,
   * but not consumed until the derivation pass (step 3).
   */
  readonly sessionTemplatePath: string | null;
}

/**
 * Deferred sections of the spec that a manifest may not declare yet. Rejecting these is the
 * same discipline as DEFERRED_TOOLS: a `capabilities` block that nothing enforces reads as
 * a granted capability, and the whole point of §6.3 is that declared capability is real.
 */
const DEFERRED_KEYS: Record<string, string> = {
  capabilities: 'the capability manifest (§6.3, build order step 8)',
  legend: 'markers and the legend (§5.6, build order steps 3 and 6)',
};

export async function loadModeFile(path: string): Promise<Mode> {
  const raw = await readFile(path, 'utf8');
  const document: unknown = parse(raw);

  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new ConfigInvalid(path, 'expected a YAML mapping');
  }

  for (const [key, why] of Object.entries(DEFERRED_KEYS)) {
    if (key in document) {
      throw new ConfigInvalid(
        path,
        `'${key}' is not enforced yet — it arrives with ${why}. Remove it rather than ` +
          `declaring something the core would ignore.`,
      );
    }
  }

  const parsed = ModeSchema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigInvalid(path, detail);
  }

  const manifest = parsed.data;
  const root = configRoot();

  for (const tool of manifest.tools) {
    const deferredTo = DEFERRED_TOOLS[tool];
    if (deferredTo !== undefined) {
      throw new ConfigInvalid(
        path,
        `tool '${tool}' is not implemented yet — it arrives with ${deferredTo}`,
      );
    }
    if (!(IMPLEMENTED_TOOLS as readonly string[]).includes(tool)) {
      throw new ConfigInvalid(
        path,
        `unknown tool '${tool}' (implemented: ${IMPLEMENTED_TOOLS.join(', ')})`,
      );
    }
  }

  const promptFragmentPath = join(root, manifest.prompt_fragment);
  if (!existsSync(promptFragmentPath)) {
    throw new ConfigInvalid(
      path,
      `prompt_fragment '${manifest.prompt_fragment}' does not exist`,
    );
  }

  let sessionTemplatePath: string | null = null;
  if (manifest.session_template !== undefined) {
    sessionTemplatePath = join(root, manifest.session_template);
    if (!existsSync(sessionTemplatePath)) {
      throw new ConfigInvalid(
        path,
        `session_template '${manifest.session_template}' does not exist`,
      );
    }
  }

  return {
    id: manifest.id,
    label: manifest.label,
    promptFragmentPath,
    scope: { read: manifest.scope.read, write: manifest.scope.write },
    tools: manifest.tools,
    sessionTemplatePath,
  };
}

/**
 * §3: mode controls scope, tools, and output shape. A tool the manifest does not list is
 * not available in that mode, whoever is asking for it.
 */
export function assertToolAllowed(mode: Mode, tool: string): void {
  if (!mode.tools.includes(tool)) {
    throw new CoreError(
      'tool_not_in_mode',
      `mode '${mode.id}' does not grant the '${tool}' tool (§3)`,
    );
  }
}

export async function listModes(root: string = configRoot()): Promise<Mode[]> {
  const dir = join(root, 'modes');
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.yaml')).sort();
  const modes = await Promise.all(entries.map((name) => loadModeFile(join(dir, name))));

  for (const mode of modes) {
    const expected = `${mode.id}.yaml`;
    if (!entries.includes(expected)) {
      throw new ConfigInvalid(
        join(dir, expected),
        `mode id '${mode.id}' must match its filename`,
      );
    }
  }

  return modes;
}

export async function loadMode(id: string, root: string = configRoot()): Promise<Mode> {
  const path = join(root, 'modes', `${id}.yaml`);
  if (!existsSync(path)) {
    const available = await listModes(root);
    throw new CoreError(
      'unknown_mode',
      `unknown mode '${id}' (available: ${available.map((mode) => mode.id).join(', ')})`,
    );
  }
  return loadModeFile(path);
}
