import { createInterface } from 'node:readline/promises';
import { socketPath } from '../../core/config/paths.ts';
import { CoreClient, CoreError } from './client.ts';

/**
 * The text adapter (§2.2) — the reference client and the test harness, not scaffolding to
 * be replaced later (invariant 8).
 *
 *   node src/adapters/text/main.ts --archive ~/archives/notes [--mode tutor]
 *
 * Every capability the system has is reachable from here with no microphone attached. If
 * something can only be done by voice, it is in the wrong layer.
 */

const args = process.argv.slice(2);
const archive = valueOf('--archive');
const mode = valueOf('--mode');

if (archive === undefined) {
  console.error('usage: text --archive <path> [--mode <id>]');
  process.exit(2);
}

const client = await CoreClient.connect(socketPath()).catch((error: Error) => {
  console.error(`could not reach the core at ${socketPath()}: ${error.message}`);
  console.error('start it with: pnpm daemon');
  process.exit(1);
});

let pendingEndToken: string | null = null;

client.onEvent((event) => {
  pendingEndToken = event.payload.token;
  process.stdout.write(
    `\n[${event.payload.reason}] ${event.payload.question} (/yes or /no)\n> `,
  );
});

const attached = await call<{
  identity: { name: string; personality: string };
  recovery: Recovery;
}>({ type: 'attach', archive, ...(mode !== undefined ? { mode } : {}) });
if (attached !== null) {
  reportRecovery(attached.recovery);
  console.log(
    `attached to ${archive} as ${attached.identity.name} (${attached.identity.personality})`,
  );
}

const begun = await call<{ greeting: string }>({
  type: 'session.begin',
  ...(mode !== undefined ? { mode } : {}),
});
if (begun !== null) console.log(`\n${begun.greeting}`);

console.log(
  '\n(/footnote <text>, /end, /abort, /name <x>, /personality <x>, /status, /quit)\n',
);

// Open stdin only now that attach and begin have finished. readline starts consuming its
// input the moment it is created, so an interface built before those awaits would swallow
// piped lines — and, once the pipe closed, leave the loop waiting on events already fired.
const rl = createInterface({ input: process.stdin, output: process.stdout });

// An async iterator rather than repeated question() calls: it ends cleanly at EOF, so the
// adapter behaves the same whether a person is typing or a script is piping.
process.stdout.write('> ');
for await (const raw of rl) {
  const line = raw.trim();

  if (line.length > 0) {
    if (line.startsWith('/')) {
      const [command, ...rest] = line.slice(1).split(' ');
      if (await handleCommand(command ?? '', rest.join(' ').trim())) break;
    } else {
      const said = await call<{ reply: string; committed: boolean; sessionId: string | null }>({
        type: 'session.say',
        text: line,
      });
      if (said !== null) {
        if (said.committed) console.log(`  [session ${said.sessionId}]`);
        console.log(`\n${said.reply}\n`);
      }
    }
  }

  process.stdout.write('> ');
}

rl.close();
client.close();

async function handleCommand(command: string, argument: string): Promise<boolean> {
  switch (command) {
    case 'footnote':
      if (argument.length === 0) {
        console.log('  /footnote needs some text');
        return false;
      }
      if ((await call({ type: 'session.footnote', text: argument })) !== null) {
        console.log('  noted');
      }
      return false;

    case 'end': {
      const request = await call<{ token: string; question: string }>({ type: 'session.end' });
      if (request === null) return false;
      pendingEndToken = request.token;
      console.log(`  ${request.question} (/yes or /no)`);
      return false;
    }

    case 'yes': {
      if (pendingEndToken === null) {
        console.log('  nothing is awaiting confirmation');
        return false;
      }
      const meta = await call<{ id: string }>({
        type: 'session.end.confirm',
        token: pendingEndToken,
      });
      pendingEndToken = null;
      if (meta !== null) console.log(`  closed ${meta.id}`);
      return meta !== null;
    }

    case 'no':
      pendingEndToken = null;
      await call({ type: 'session.end.cancel' });
      console.log('  still going');
      return false;

    case 'abort':
      if ((await call({ type: 'session.abort' })) !== null) console.log('  buffer discarded');
      return true;

    case 'name':
      return printResult(await call({ type: 'identity.set', name: argument }));

    case 'personality':
      return printResult(
        await call({
          type: 'identity.set',
          personality: argument as 'plain' | 'warm' | 'dry' | 'socratic' | 'expansive',
        }),
      );

    case 'status':
      return printResult(await call({ type: 'session.status' }));

    case 'modes':
      return printResult(await call({ type: 'modes.list' }));

    case 'quit':
      return true;

    default:
      console.log(`  unknown command /${command}`);
      return false;
  }
}

function printResult(result: unknown): boolean {
  if (result !== null)
    console.log(`  ${JSON.stringify(result, null, 2).replaceAll('\n', '\n  ')}`);
  return false;
}

interface Recovery {
  crashedSessions: string[];
  promotedBuffers: string[];
  discardedBuffers: string[];
}

function reportRecovery(recovery: Recovery): void {
  for (const id of recovery.crashedSessions) {
    console.log(`recovered ${id} — the process died with it open; closed as a crash`);
  }
  for (const id of recovery.promotedBuffers) {
    console.log(`recovered ${id} — an unscoped buffer that never reached intake`);
  }
  if (recovery.discardedBuffers.length > 0) {
    console.log(`discarded ${recovery.discardedBuffers.length} empty buffer(s)`);
  }
}

async function call<T>(request: Parameters<CoreClient['request']>[0]): Promise<T | null> {
  try {
    return await client.request<T>(request);
  } catch (error) {
    const code = error instanceof CoreError ? error.code : 'error';
    console.error(`  ! ${code}: ${(error as Error).message}`);
    return null;
  }
}

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
