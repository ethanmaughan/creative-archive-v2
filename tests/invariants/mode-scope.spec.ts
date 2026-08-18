import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScopeViolation } from '../../src/core/errors.ts';
import { DEFAULT_IDENTITY } from '../../src/core/identity/identity.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { assertToolAllowed, listModes, loadMode, type Mode } from '../../src/core/modes/mode.ts';
import { Session } from '../../src/core/session/session.ts';
import { ScopedFileStore } from '../../src/core/storage/scoped-file-store.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

/**
 * Invariant: mode scope actually prevents out-of-scope writes (§3, D-007).
 *
 * Enforcement lives in the store rather than in each tool, so these tests go at the store —
 * the point being that there is no route to the filesystem that skips the check, not that
 * one particular caller remembers to make it.
 */
describe('invariant: mode scope prevents out-of-scope writes', () => {
  let sandbox: Sandbox;
  let tutor: Mode;

  beforeEach(async () => {
    sandbox = makeSandbox('ca2-scope');
    tutor = await loadMode('tutor');
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  const scoped = async (mode: Mode): Promise<ScopedFileStore> => {
    const archive = await sandbox.open();
    return new ScopedFileStore(archive.store, mode.scope, mode.id);
  };

  it('allows a write inside the declared scope', async () => {
    const store = await scoped(tutor);
    await expect(store.write('sessions/x/notes.md', 'ok')).resolves.toBeUndefined();
  });

  it('refuses a write outside the declared scope', async () => {
    const store = await scoped(tutor);
    await expect(store.write('notes/idea.md', 'nope')).rejects.toThrow(ScopeViolation);
    await expect(store.write('README.md', 'nope')).rejects.toThrow(ScopeViolation);
  });

  it('refuses every mutating operation, not only write', async () => {
    const store = await scoped(tutor);
    await expect(store.mkdir('notes')).rejects.toThrow(ScopeViolation);
    await expect(store.remove('notes/idea.md')).rejects.toThrow(ScopeViolation);
    await expect(store.rename('sessions/a.md', 'notes/a.md')).rejects.toThrow(ScopeViolation);
    expect(() => store.openAppend('notes/idea.md')).toThrow(ScopeViolation);
  });

  it('refuses to append to a file outside scope even after opening one inside it', async () => {
    const store = await scoped(tutor);
    const handle = store.openAppend('sessions/x/transcript.md');
    handle.appendAndSync('in scope\n');
    handle.close();
    expect(() => store.openAppend('../outside.md')).toThrow();
  });

  it('refuses a read outside the read scope', async () => {
    const narrow: Mode = { ...tutor, scope: { read: ['sessions/**'], write: ['sessions/**'] } };
    const store = await scoped(narrow);
    await expect(store.read('notes/idea.md')).rejects.toThrow(ScopeViolation);
    await expect(store.list('notes')).rejects.toThrow(ScopeViolation);
  });

  it('stops a session from committing when its mode cannot write to sessions/', async () => {
    // A mode whose scope excludes the session folder cannot hold a session at all. The
    // failure lands at commit, before the buffer is moved, so nothing is half-written.
    const archive = await sandbox.open();
    const walled: Mode = { ...tutor, id: 'walled', scope: { read: ['**'], write: ['notes/**'] } };

    const session = await Session.begin({
      archive,
      identity: DEFAULT_IDENTITY,
      model: new ScriptedModelClient(),
      modes: await listModes(),
      mode: walled,
    });

    await expect(session.say('this should not commit')).rejects.toThrow(ScopeViolation);
    expect(await archive.store.exists('sessions')).toBe(false);
    expect(session.state).toBe('buffering');
    expect(await archive.store.read(session.transcriptPath)).toContain('this should not commit');
  });

  it('refuses a tool the mode does not grant (§3)', async () => {
    const toolless: Mode = { ...tutor, tools: ['session_end'] };
    expect(() => assertToolAllowed(toolless, 'footnote')).toThrow(/does not grant/);
    expect(() => assertToolAllowed(tutor, 'footnote')).not.toThrow();
  });

  it('keeps core bookkeeping out of every mode scope', async () => {
    // Identity, the scratch buffer, and the open-session pointer are core state. No mode
    // grants write access to them, which is what keeps them out of the agent's reach.
    const store = await scoped(tutor);
    for (const path of [
      '.creative-archive/identity.yaml',
      '.creative-archive/open-session.yaml',
      '.creative-archive/scratch/pending-x.md',
    ]) {
      await expect(store.write(path, 'nope'), path).rejects.toThrow(ScopeViolation);
    }
  });
});
