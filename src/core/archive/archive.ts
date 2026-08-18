import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ARCHIVE_INTERNAL_DIR } from '../config/paths.ts';
import { ArchiveNotVersioned, CoreError } from '../errors.ts';
import { NodeFileStore } from '../storage/node-file-store.ts';
import { assertAllowed, loadAllowlist } from './allowlist.ts';

export interface Archive {
  readonly root: string;
  /** Unscoped store. Mode scope is applied per session, not here (§3, D-007). */
  readonly store: NodeFileStore;
  /** Archive-relative path of the core's own state directory. */
  readonly internalDir: string;
}

/**
 * Walk up looking for a git working tree. A `.git` entry may be a directory (normal clone)
 * or a file (a linked worktree), so existence is the test, not type.
 */
export function findGitRoot(start: string): string | null {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Open an archive for use.
 *
 * Two gates, both structural rather than habitual:
 *   - the root is on the user-level allowlist (§6.0)
 *   - the root is inside a git working tree (D-008)
 *
 * The second is what lets §6.2 classify in-scope writes as reversible without any gate at
 * all: the diff is the undo. An unversioned archive has no undo, so the core refuses it
 * rather than quietly downgrading the guarantee.
 */
export async function openArchive(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Archive> {
  const absolute = resolve(root);

  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new CoreError('archive_missing', `archive root '${absolute}' is not a directory`);
  }

  assertAllowed(absolute, await loadAllowlist(env));

  if (findGitRoot(absolute) === null) {
    throw new ArchiveNotVersioned(absolute);
  }

  return {
    root: absolute,
    store: new NodeFileStore(absolute),
    internalDir: ARCHIVE_INTERNAL_DIR,
  };
}
