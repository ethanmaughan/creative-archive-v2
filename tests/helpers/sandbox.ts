import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openArchive, type Archive } from '../../src/core/archive/archive.ts';

export interface Sandbox {
  readonly dir: string;
  readonly stateDir: string;
  readonly archiveRoot: string;
  readonly env: NodeJS.ProcessEnv;
  open(): Promise<Archive>;
  cleanup(): void;
}

/**
 * A real archive on disk: allowlisted, git-versioned, empty. Both gates in `openArchive`
 * are satisfied the way a user would satisfy them rather than bypassed, so every test runs
 * through the same door production does.
 */
export function makeSandbox(name = 'ca2'): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const stateDir = join(dir, 'state');
  const archiveRoot = join(dir, 'archive');

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(archiveRoot, '.git'), { recursive: true });
  writeFileSync(join(stateDir, 'archives.yaml'), `archives:\n  - ${archiveRoot}\n`, 'utf8');

  const env: NodeJS.ProcessEnv = { CREATIVE_ARCHIVE_STATE_DIR: stateDir };

  return {
    dir,
    stateDir,
    archiveRoot,
    env,
    open: () => openArchive(archiveRoot, env),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A clock that does not move, so two runs of the same script produce the same timestamps. */
export function fixedClock(iso = '2026-08-18T14:32:00.000Z'): () => Date {
  return () => new Date(iso);
}
