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
  index: { documents: number; spans: number; buildMs: number; generation: number };
  legend: { source: string; markers: Array<{ phrase: string; id: string }> };
}>({ type: 'attach', archive, ...(mode !== undefined ? { mode } : {}) });
if (attached !== null) {
  reportRecovery(attached.recovery);
  console.log(
    `attached to ${archive} as ${attached.identity.name} (${attached.identity.personality})`,
  );
  console.log(
    `indexed ${attached.index.documents} document(s), ${attached.index.spans} span(s) in ` +
      `${attached.index.buildMs} ms (generation ${attached.index.generation})`,
  );
  if (attached.legend.markers.length > 0) {
    console.log(
      `markers: ${attached.legend.markers.map((marker) => `"${marker.phrase}"`).join(', ')}`,
    );
  }
}

const begun = await call<{ greeting: string }>({
  type: 'session.begin',
  ...(mode !== undefined ? { mode } : {}),
});
if (begun !== null) console.log(`\n${begun.greeting}`);

console.log(
  '\n(/search <query>, /footnote <text>, /legend, /end, /derive, /abort, /name <x>, /personality <x>, /index, /status, /quit)\n',
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
      const said = await call<{
        reply: string;
        committed: boolean;
        sessionId: string | null;
        marker?: { id: string; note: string };
      }>({ type: 'session.say', text: line });
      if (said !== null) {
        if (said.marker !== undefined) {
          // Markers fire silently and are never confirmed (§5.6). This one line is an echo
          // for a typist, not a confirmation — nothing is waiting on it.
          console.log(`  ⟨${said.marker.id}⟩\n`);
        } else {
          if (said.committed) console.log(`  [session ${said.sessionId}]`);
          console.log(`\n${said.reply}\n`);
        }
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

    case 'search': {
      if (argument.length === 0) {
        console.log('  /search needs a query — try: pivots tag:linalg after:2026-01');
        return false;
      }
      const result = await call<SearchResult>({ type: 'session.search', query: argument });
      if (result === null) return false;

      console.log(`  searched: ${result.searched.filters}`);
      console.log(
        `  scope ${result.searched.scope.join(', ')} · generation ${result.searched.generation} · ` +
          `${result.searched.candidateSpans} candidate span(s) · ${result.searched.matchMode}`,
      );
      if (result.searched.ignored.length > 0) {
        console.log(`  ignored: ${result.searched.ignored.join(', ')}`);
      }
      if (result.spans.length === 0) {
        console.log('  nothing matched');
        return false;
      }
      result.spans.forEach((span, position) => {
        const where = span.heading === null ? span.title : `${span.title} › ${span.heading}`;
        const stamp = span.date === null ? span.provenance : `${span.provenance}, ${span.date}`;
        console.log(`\n  [${position + 1}] ${span.deepLink}`);
        console.log(`      ${where} (${stamp})`);
        console.log(`      matched [${span.matched.join(', ')}] score ${span.score}`);
        console.log(`      ${span.text.replace(/\n/g, '\n      ')}`);
      });
      console.log('');
      return false;
    }

    case 'derive': {
      const report = await call<DerivationReport>({
        type: 'session.derive',
        ...(argument.length > 0 ? { sessionId: argument } : {}),
      });
      if (report === null) return false;

      if (report.outcome !== 'derived') {
        console.log(`  ${report.outcome} — nothing written`);
        return false;
      }
      console.log(`  minutes for ${report.sessionId} (${report.model})`);
      console.log(`  ${report.wrote.join(', ')}`);
      console.log(
        `  ${report.highlights} highlight(s), ${report.openThreads} open thread(s)` +
          `${report.tags.length > 0 ? `, tags [${report.tags.join(', ')}]` : ''}`,
      );
      if (report.markerThreads > 0 || report.yieldedToMarkers > 0) {
        console.log(
          `  ${report.markerThreads} thread(s) from your markers; ` +
            `${report.yieldedToMarkers} proposal(s) yielded to them`,
        );
      }
      if (report.droppedReferences > 0) {
        console.log(
          `  ${report.droppedReferences} citation(s) pointed at turns that do not exist`,
        );
      }
      if (report.unresolvedPlaceholders.length > 0) {
        console.log(`  template asked for: ${report.unresolvedPlaceholders.join(', ')}`);
      }
      return false;
    }

    case 'index':
      return printResult(await call({ type: 'index.status' }));

    case 'reindex':
      return printResult(await call({ type: 'index.rebuild' }));

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

    case 'abort': {
      // Only leave if the abort actually happened. Quitting on a refusal would abandon the
      // very session the core just declined to throw away.
      const aborted = await call({ type: 'session.abort' });
      if (aborted === null) return false;
      console.log('  buffer discarded');
      return true;
    }

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

    case 'legend':
      return printResult(await call({ type: 'legend.list' }));

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

interface DerivationReport {
  sessionId: string;
  outcome: string;
  wrote: string[];
  tags: string[];
  highlights: number;
  openThreads: number;
  droppedReferences: number;
  yieldedToMarkers: number;
  markerThreads: number;
  unresolvedPlaceholders: string[];
  model: string;
}

interface SearchResult {
  spans: Array<{
    deepLink: string;
    title: string;
    heading: string | null;
    provenance: string;
    date: string | null;
    text: string;
    score: number;
    matched: string[];
  }>;
  searched: {
    filters: string;
    scope: string[];
    generation: number;
    candidateSpans: number;
    matchMode: string;
    ignored: string[];
  };
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
