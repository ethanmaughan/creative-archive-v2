import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Where user-level state lives (D-006).
 *
 * The split matters: identity is per-archive and lives *inside* the archive, but the
 * archive-root allowlist (§6.0) cannot — an archive that could authorize itself is not an
 * allowlist. Anything that grants access is therefore user-level, outside every archive.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CREATIVE_ARCHIVE_STATE_DIR;
  if (override && override.length > 0) return resolve(expandHome(override));

  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'creative-archive');
  }
  const xdg = env.XDG_STATE_HOME;
  if (xdg && xdg.length > 0) return join(resolve(expandHome(xdg)), 'creative-archive');
  return join(homedir(), '.local', 'state', 'creative-archive');
}

export function allowlistPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), 'archives.yaml');
}

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CREATIVE_ARCHIVE_SOCKET;
  if (override && override.length > 0) return resolve(expandHome(override));
  return join(stateDir(env), 'daemon.sock');
}

/** Repo-shipped config: mode manifests, prompt fragments, session templates. */
export function configRoot(): string {
  // src/core/config → repo root
  return resolve(import.meta.dirname, '..', '..', '..', 'config');
}

/** Core-owned state inside an archive. Not part of any mode's scope. */
export const ARCHIVE_INTERNAL_DIR = '.creative-archive';

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
