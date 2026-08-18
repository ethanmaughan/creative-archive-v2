import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { allowlistPath, expandHome } from '../config/paths.ts';
import { ArchiveNotAllowed, ConfigInvalid } from '../errors.ts';

const AllowlistFile = z.object({
  archives: z.array(z.string().min(1)).default([]),
});

export interface Allowlist {
  readonly path: string;
  readonly roots: readonly string[];
}

/**
 * The archive-root allowlist (§6.0). Explicit by design: there is no "scope to an arbitrary
 * directory" path, and no API that adds an entry. Editing this file is deliberately a
 * manual act outside the running system, so scoping never becomes a question of what you
 * remember at 11pm.
 */
export async function loadAllowlist(env: NodeJS.ProcessEnv = process.env): Promise<Allowlist> {
  const path = allowlistPath(env);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, roots: [] };
    }
    throw error;
  }

  const parsed = AllowlistFile.safeParse(parse(raw) ?? {});
  if (!parsed.success) {
    throw new ConfigInvalid(path, parsed.error.issues.map((i) => i.message).join('; '));
  }

  return {
    path,
    roots: parsed.data.archives.map((entry) => resolve(expandHome(entry))),
  };
}

/** Exact match only. An allowlisted root does not allowlist its siblings or its parent. */
export function assertAllowed(root: string, allowlist: Allowlist): void {
  const candidate = resolve(root);
  if (!allowlist.roots.includes(candidate)) {
    throw new ArchiveNotAllowed(candidate, allowlist.path);
  }
}
