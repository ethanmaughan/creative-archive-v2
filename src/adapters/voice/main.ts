import { socketPath } from '../../core/config/paths.ts';
import { matchControl } from '../../core/markers/control.ts';
import type { Legend } from '../../core/markers/legend.ts';
import { CoreClient, CoreError } from '../text/client.ts';
import { parseArgs, resolveVoice, validateModels } from './config.ts';
import {
  createVad,
  createStt,
  createTts,
  type VadEngine,
  type SttEngine,
  type TtsEngine,
} from './engine.ts';
import { createMicCapture, createSpeaker, type MicCapture, type Speaker } from './audio.ts';
import { startPtt, type PttHandle } from './ptt.ts';

/**
 * The voice adapter (§2.3 Tier 1) — VAD → streaming STT → core → TTS → speaker.
 *
 *   node src/adapters/voice/main.ts --archive ~/archives/notes [--mode tutor] [--voice default]
 *
 * Same wire protocol as the text adapter. The core has no knowledge of audio (invariant 2).
 */

// ── State ─────────────────────────────────────────────────────────────────────

type AdapterState = 'idle' | 'listening' | 'processing' | 'playing' | 'confirming';

let state: AdapterState = 'idle';
let pendingEndToken: string | null = null;

/** Read current state without narrowing (state mutates from concurrent callbacks). */
function currentState(): AdapterState {
  return state;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const config = parseArgs(process.argv);

const missing = validateModels(config);
if (missing.length > 0) {
  console.error('missing required models:');
  for (const m of missing) console.error(`  ${m}`);
  console.error('\ndownload models to the models/ directory. see --help for details.');
  process.exit(2);
}

const voiceEntry = resolveVoice(config, config.voice);
if (voiceEntry === undefined) {
  console.error(`voice "${config.voice}" not found in voices.yaml`);
  if (config.voices.length > 0) {
    console.error(`available: ${config.voices.map((v) => v.id).join(', ')}`);
  } else {
    console.error('no voices registered. create models/voices.yaml');
  }
  process.exit(2);
}

setState('idle');
console.log('loading models...');

let vad: VadEngine;
let stt: SttEngine;
let tts: TtsEngine;
try {
  vad = createVad(config.vadModel);
  console.log('  VAD loaded');
  stt = createStt(config.sttDir, config.sttTokens);
  console.log('  STT loaded');
  tts = createTts(voiceEntry);
  console.log(`  TTS loaded (voice: ${voiceEntry.id}, ${tts.sampleRate()} Hz)`);
} catch (error) {
  console.error(`failed to load models: ${(error as Error).message}`);
  process.exit(1);
}

const mic: MicCapture = createMicCapture(config.audioInputDevice);
const speaker: Speaker = createSpeaker();

// ── Core connection ───────────────────────────────────────────────────────────

const client = await CoreClient.connect(socketPath()).catch((error: Error) => {
  console.error(`could not reach the core at ${socketPath()}: ${error.message}`);
  console.error('start it with: pnpm daemon');
  cleanup();
  process.exit(1);
});

client.onEvent((event) => {
  pendingEndToken = event.payload.token;
  setState('confirming');
  console.log(`\n[${event.payload.reason}] ${event.payload.question}`);
  console.log('say "yes" or "no"');
});

const attached = await call<{
  identity: { name: string; personality: string };
  legend: { source: string; markers: Array<Record<string, unknown>> };
}>({
  type: 'attach',
  archive: config.archive,
  ...(config.mode !== undefined ? { mode: config.mode } : {}),
});

// Reconstruct a Legend from the attach response so we can match control phrases locally.
let adapterLegend: Legend = { source: 'none', entries: [] };
if (attached !== null) {
  console.log(
    `attached to ${config.archive} as ${attached.identity.name} (${attached.identity.personality})`,
  );
}

// Load the full legend (including control entries) from the core.
const legendData = await call<{
  source: string;
  markers: Array<{
    phrase: string;
    id: string;
    namespace?: string;
    safety?: string;
    captures?: string;
    span?: string;
    writes?: string[];
  }>;
}>({ type: 'legend.list' });
if (legendData !== null) {
  adapterLegend = {
    source: legendData.source,
    entries: legendData.markers.map((m) => {
      if (m.namespace === 'control') {
        return {
          phrase: m.phrase,
          normalized: m.phrase.trim().toLowerCase().replace(/\s+/g, ' '),
          namespace: 'control' as const,
          id: m.id,
          safety: (m.safety ?? 'safe') as 'safe' | 'confirm',
          ...(m.captures !== undefined ? { captures: m.captures as 'rest' } : {}),
        };
      }
      return {
        phrase: m.phrase,
        normalized: m.phrase.trim().toLowerCase().replace(/\s+/g, ' '),
        namespace: 'tag' as const,
        id: m.id,
        span: (m.span ?? 'forward') as 'forward',
        writes: (m.writes ?? ['transcript']) as Array<'transcript' | 'error-index'>,
      };
    }),
  };
}

const begun = await call<{ greeting: string }>({
  type: 'session.begin',
  ...(config.mode !== undefined ? { mode: config.mode } : {}),
});
if (begun !== null) console.log(`\n${begun.greeting}`);

console.log(
  '\npress [SPACE] to start/stop recording. voice commands: "end session", "yes", "no", "quit"',
);
console.log(`voice: ${tts.currentVoice()}\n`);

// ── Audio capture pipeline ────────────────────────────────────────────────────

let capturedSamples: Float32Array[] = [];

function onAudioData(samples: Float32Array): void {
  capturedSamples.push(samples);
  // Feed STT for streaming partial results.
  const partial = stt.feed(samples);
  if (partial.length > 0) {
    process.stdout.write(`\r  [hearing] ${partial}    `);
  }
}

// ── PTT ───────────────────────────────────────────────────────────────────────

const ptt: PttHandle = startPtt({
  onStart(): void {
    if (state === 'playing') {
      // Barge-in: stop TTS playback.
      speaker.stop();
    }
    if (state !== 'idle' && state !== 'confirming' && state !== 'playing') return;

    setState('listening');
    capturedSamples = [];
    stt.reset();
    vad.reset();
    mic.start(onAudioData);
  },

  async onStop(): Promise<void> {
    if (state !== 'listening') return;

    mic.stop();
    setState('processing');
    process.stdout.write('\r                                                        \r');

    // Finalize STT.
    const transcript = stt.finalize();

    if (transcript.length === 0) {
      console.log('  (nothing heard)');
      setState('idle');
      return;
    }

    console.log(`  you: ${transcript}`);

    // Check for voice commands before sending to core.
    const handled = await handleVoiceCommand(transcript);
    if (handled) return;

    // Send to core.
    const said = await call<{
      reply: string;
      committed: boolean;
      sessionId: string | null;
      marker?: { id: string; note: string };
    }>({ type: 'session.say', text: transcript });

    if (said === null) {
      setState('idle');
      return;
    }

    if (said.marker !== undefined) {
      console.log(`  ⟨${said.marker.id}⟩`);
      setState('idle');
      return;
    }

    if (said.committed) console.log(`  [session ${said.sessionId}]`);
    console.log(`\n  ${said.reply}\n`);

    // Speak the reply.
    setState('playing');
    try {
      const audio = tts.synthesize(said.reply);
      await speaker.play(audio.samples, audio.sampleRate);
    } catch (error) {
      console.error(`  [tts error: ${(error as Error).message}]`);
    }

    if (currentState() === 'playing') setState('idle');
  },
});

// ── Voice commands ────────────────────────────────────────────────────────────

/**
 * Tier 0 phrase dispatch (§2.3): control phrases from the legend, plus adapter-local commands.
 *
 * Control phrases are matched from the legend's control namespace — deterministic, sub-second,
 * no LLM. Adapter-local commands (voice switching, quit, yes/no confirmation) stay hardcoded
 * because they are not archive vocabulary.
 */
async function handleVoiceCommand(transcript: string): Promise<boolean> {
  const lower = transcript.toLowerCase().trim();

  // ── Adapter-local: confirmation responses (UX, not phrases) ─────────────
  if (state === 'confirming' || pendingEndToken !== null) {
    if (lower === 'yes' || lower === 'yeah' || lower === 'confirm') {
      if (pendingEndToken !== null) {
        const meta = await call<{ id: string }>({
          type: 'session.end.confirm',
          token: pendingEndToken,
        });
        pendingEndToken = null;
        if (meta !== null) {
          console.log(`  closed ${meta.id}`);
          await shutdown();
          return true;
        }
      }
      setState('idle');
      return true;
    }
    if (lower === 'no' || lower === 'nah' || lower === 'cancel') {
      pendingEndToken = null;
      await call({ type: 'session.end.cancel' });
      console.log('  still going');
      setState('idle');
      return true;
    }
  }

  // ── Adapter-local: voice switching and quit ─────────────────────────────
  if (lower.startsWith('switch voice to ')) {
    const voiceId = lower.slice('switch voice to '.length).trim();
    const entry = resolveVoice(config, voiceId);
    if (entry === undefined) {
      console.log(`  voice "${voiceId}" not found`);
      console.log(`  available: ${config.voices.map((v) => v.id).join(', ')}`);
    } else if (tts.setVoice(entry)) {
      console.log(`  voice switched to ${entry.id} (${tts.sampleRate()} Hz)`);
    } else {
      console.log(`  failed to load voice "${voiceId}"`);
    }
    setState('idle');
    return true;
  }

  if (lower === 'quit' || lower === 'exit') {
    await shutdown();
    return true;
  }

  // ── Tier 0: registry-driven control phrases from the legend ─────────────
  const match = matchControl(transcript, adapterLegend);
  if (match === null) return false;

  if (match.entry.safety === 'confirm') {
    return dispatchConfirm(match.entry.id);
  }
  return dispatchSafe(match.entry.id, match.argument);
}

/** Dispatch a `confirm` control phrase: initiate and wait for yes/no. */
async function dispatchConfirm(id: string): Promise<boolean> {
  switch (id) {
    case 'session-end':
    case 'session-end-alt': {
      const request = await call<{ token: string; question: string }>({
        type: 'session.end',
      });
      if (request !== null) {
        pendingEndToken = request.token;
        setState('confirming');
        console.log(`  ${request.question} (say "yes" or "no")`);
        try {
          const audio = tts.synthesize(request.question);
          await speaker.play(audio.samples, audio.sampleRate);
        } catch {
          /* fallback to text */
        }
      }
      return true;
    }
    case 'session-abort':
    case 'session-abort-alt': {
      const aborted = await call({ type: 'session.abort' });
      if (aborted !== null) {
        console.log('  buffer discarded');
        await shutdown();
      }
      return true;
    }
    default:
      console.log(`  unknown confirm command: ${id}`);
      setState('idle');
      return true;
  }
}

/** Dispatch a `safe` control phrase: fire immediately. */
async function dispatchSafe(id: string, argument: string): Promise<boolean> {
  switch (id) {
    case 'footnote': {
      if (argument.length > 0) {
        if ((await call({ type: 'session.footnote', text: argument })) !== null) {
          console.log('  noted');
        }
      }
      setState('idle');
      return true;
    }
    case 'search': {
      if (argument.length > 0) {
        const result = await call({ type: 'session.search', query: argument });
        if (result !== null) {
          console.log(`  search: ${JSON.stringify(result, null, 2).replaceAll('\n', '\n  ')}`);
        }
      }
      setState('idle');
      return true;
    }
    default:
      console.log(`  unknown safe command: ${id}`);
      setState('idle');
      return true;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function setState(next: AdapterState): void {
  state = next;
  const labels: Record<AdapterState, string> = {
    idle: '[space to talk]',
    listening: '[listening...]',
    processing: '[processing...]',
    playing: '[speaking...]',
    confirming: '[confirm?]',
  };
  process.stdout.write(`\r${labels[next]}  `);
}

async function shutdown(): Promise<void> {
  mic.stop();
  speaker.stop();
  ptt.destroy();
  client.close();
  process.exit(0);
}

function cleanup(): void {
  mic?.destroy();
  speaker?.destroy();
}

process.on('SIGINT', () => {
  console.log('\n');
  cleanup();
  process.exit(0);
});

async function call<T>(request: Parameters<CoreClient['request']>[0]): Promise<T | null> {
  try {
    return await client.request<T>(request);
  } catch (error) {
    const code = error instanceof CoreError ? error.code : 'error';
    console.error(`  ! ${code}: ${(error as Error).message}`);
    return null;
  }
}
