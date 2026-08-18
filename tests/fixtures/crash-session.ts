/**
 * Runs a real session in a real process and then dies without warning.
 *
 * Spawned by the crash-survival and recovery invariant tests. It must be a separate
 * process: SIGKILL is the only faithful way to test that nothing was waiting in a buffer,
 * and a fake cannot prove anything about fsync.
 *
 *   node tests/fixtures/crash-session.ts <archiveRoot> <utterance...>
 */
import { openArchive } from '../../src/core/archive/archive.ts';
import { DEFAULT_IDENTITY } from '../../src/core/identity/identity.ts';
import { ScriptedModelClient } from '../../src/core/model/scripted-model.ts';
import { listModes, loadMode } from '../../src/core/modes/mode.ts';
import { Session } from '../../src/core/session/session.ts';

const [archiveRoot, ...utterances] = process.argv.slice(2);
if (archiveRoot === undefined) {
  throw new Error('usage: crash-session.ts <archiveRoot> <utterance...>');
}

const archive = await openArchive(archiveRoot, process.env);
const session = await Session.begin({
  archive,
  identity: DEFAULT_IDENTITY,
  model: new ScriptedModelClient({ replies: ['Go on.'] }),
  modes: await listModes(),
  mode: process.env.CRASH_BEFORE_COMMIT === '1' ? undefined : await loadMode('tutor'),
});

for (const utterance of utterances) {
  await session.say(utterance);
}

// No flush, no close, no cleanup. Whatever is on disk is on disk.
process.kill(process.pid, 'SIGKILL');
