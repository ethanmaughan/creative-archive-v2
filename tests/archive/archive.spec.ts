import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAllowlist } from '../../src/core/archive/allowlist.ts';
import { findGitRoot, openArchive } from '../../src/core/archive/archive.ts';
import { ArchiveNotAllowed, ArchiveNotVersioned } from '../../src/core/errors.ts';
import {
  DEFAULT_IDENTITY,
  loadIdentity,
  saveIdentity,
} from '../../src/core/identity/identity.ts';

describe('archive gates', () => {
  let sandbox: string;
  let stateDir: string;
  let archiveRoot: string;
  let env: NodeJS.ProcessEnv;

  const allowlist = (...roots: string[]): void => {
    writeFileSync(
      join(stateDir, 'archives.yaml'),
      `archives:\n${roots.map((root) => `  - ${root}\n`).join('')}`,
      'utf8',
    );
  };

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'ca2-arch-'));
    stateDir = join(sandbox, 'state');
    archiveRoot = join(sandbox, 'archive');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(archiveRoot, '.git'), { recursive: true });
    env = { CREATIVE_ARCHIVE_STATE_DIR: stateDir };
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('opens an allowlisted archive inside a git working tree', async () => {
    allowlist(archiveRoot);
    const archive = await openArchive(archiveRoot, env);
    expect(archive.root).toBe(archiveRoot);
    expect(archive.internalDir).toBe('.creative-archive');
  });

  it('refuses an archive that is not on the allowlist (§6.0)', async () => {
    allowlist(join(sandbox, 'some-other-archive'));
    await expect(openArchive(archiveRoot, env)).rejects.toThrow(ArchiveNotAllowed);
  });

  it('treats a missing allowlist as allowing nothing', async () => {
    const list = await loadAllowlist(env);
    expect(list.roots).toEqual([]);
    await expect(openArchive(archiveRoot, env)).rejects.toThrow(ArchiveNotAllowed);
  });

  it('does not let an allowlisted parent authorize a child directory', async () => {
    const child = join(archiveRoot, 'nested');
    mkdirSync(child, { recursive: true });
    allowlist(archiveRoot);
    await expect(openArchive(child, env)).rejects.toThrow(ArchiveNotAllowed);
  });

  it('refuses an archive outside a git working tree (D-008)', async () => {
    const unversioned = mkdtempSync(join(tmpdir(), 'ca2-nogit-'));
    try {
      allowlist(unversioned);
      await expect(openArchive(unversioned, env)).rejects.toThrow(ArchiveNotVersioned);
    } finally {
      rmSync(unversioned, { recursive: true, force: true });
    }
  });

  it('accepts a linked worktree, where .git is a file', async () => {
    const worktree = join(sandbox, 'worktree');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n', 'utf8');
    allowlist(worktree);
    await expect(openArchive(worktree, env)).resolves.toBeDefined();
  });

  it('finds the git root from a nested directory', () => {
    const nested = join(archiveRoot, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(archiveRoot);
  });
});

describe('identity persistence (D-003, per archive)', () => {
  let sandbox: string;
  let stateDir: string;
  let archiveRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'ca2-ident-'));
    stateDir = join(sandbox, 'state');
    archiveRoot = join(sandbox, 'archive');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(archiveRoot, '.git'), { recursive: true });
    writeFileSync(join(stateDir, 'archives.yaml'), `archives:\n  - ${archiveRoot}\n`, 'utf8');
    env = { CREATIVE_ARCHIVE_STATE_DIR: stateDir };
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('defaults when the archive has no identity yet', async () => {
    const archive = await openArchive(archiveRoot, env);
    expect(await loadIdentity(archive.store)).toEqual(DEFAULT_IDENTITY);
  });

  it('round-trips name and personality inside the archive', async () => {
    const archive = await openArchive(archiveRoot, env);
    await saveIdentity(archive.store, { name: 'Alena', personality: 'dry' });
    expect(await loadIdentity(archive.store)).toEqual({ name: 'Alena', personality: 'dry' });
    expect(await archive.store.read('.creative-archive/identity.yaml')).toContain(
      'name: Alena',
    );
  });

  it('keeps identity independent per archive', async () => {
    const second = join(sandbox, 'archive-two');
    mkdirSync(join(second, '.git'), { recursive: true });
    writeFileSync(
      join(stateDir, 'archives.yaml'),
      `archives:\n  - ${archiveRoot}\n  - ${second}\n`,
      'utf8',
    );

    const one = await openArchive(archiveRoot, env);
    const two = await openArchive(second, env);
    await saveIdentity(one.store, { name: 'Alena', personality: 'dry' });
    await saveIdentity(two.store, { name: 'Tutor', personality: 'socratic' });

    expect(await loadIdentity(one.store)).toEqual({ name: 'Alena', personality: 'dry' });
    expect(await loadIdentity(two.store)).toEqual({ name: 'Tutor', personality: 'socratic' });
  });

  it('rejects an unknown personality in a hand-edited identity file', async () => {
    const archive = await openArchive(archiveRoot, env);
    await archive.store.write(
      '.creative-archive/identity.yaml',
      'name: X\npersonality: sassy\n',
    );
    await expect(loadIdentity(archive.store)).rejects.toThrow(/personality/);
  });
});
