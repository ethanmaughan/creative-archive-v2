import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  OfflineTts,
  OfflineTtsConfig,
  OnlineRecognizer,
  OnlineRecognizerConfig,
  OnlineStream,
  Vad as SherpaVad,
  VadConfig,
} from 'sherpa-onnx-node';
import type { VoiceEntry } from './config.ts';

// sherpa-onnx-node is a CJS native addon; createRequire is the clean way to load it from ESM.
const require = createRequire(import.meta.url);

interface SherpaModule {
  Vad: new (config: VadConfig, bufferSizeInSeconds: number) => SherpaVad;
  OnlineRecognizer: new (config: OnlineRecognizerConfig) => OnlineRecognizer;
  OfflineTts: new (config: OfflineTtsConfig) => OfflineTts;
}

const SherpaOnnx: SherpaModule = require('sherpa-onnx-node');

// ── VAD ───────────────────────────────────────────────────────────────────────

export interface VadEngine {
  /** Feed raw PCM samples (Float32Array, [-1,1], 16 kHz mono). */
  feed(samples: Float32Array): void;
  /** Flush any remaining audio in the internal buffer. */
  flush(): void;
  /** True if at least one speech segment is available. */
  hasSegment(): boolean;
  /** Return the next speech segment's samples and remove it from the queue. */
  take(): Float32Array;
  /** Reset internal state. */
  reset(): void;
}

export function createVad(modelPath: string): VadEngine {
  const vad = new SherpaOnnx.Vad(
    {
      sileroVad: {
        model: modelPath,
        threshold: 0.5,
        minSilenceDuration: 0.25,
        minSpeechDuration: 0.15,
        windowSize: 512,
      },
      sampleRate: 16000,
      numThreads: 1,
      debug: false,
    },
    30, // buffer size in seconds
  );

  return {
    feed(samples: Float32Array): void {
      // Silero VAD expects chunks of exactly windowSize samples.
      const windowSize = 512;
      for (let offset = 0; offset + windowSize <= samples.length; offset += windowSize) {
        vad.acceptWaveform(samples.subarray(offset, offset + windowSize));
      }
    },

    flush(): void {
      vad.flush();
    },

    hasSegment(): boolean {
      return !vad.isEmpty();
    },

    take(): Float32Array {
      const segment = vad.front();
      vad.pop();
      return segment.samples;
    },

    reset(): void {
      vad.reset();
    },
  };
}

// ── Streaming STT ─────────────────────────────────────────────────────────────

export interface SttEngine {
  /** Feed audio samples (Float32Array, [-1,1], 16 kHz mono). Returns partial text if available. */
  feed(samples: Float32Array): string;
  /** Signal end of input, return final transcript. */
  finalize(): string;
  /** Reset for a new utterance. */
  reset(): void;
}

export function createStt(modelDir: string, tokensPath: string): SttEngine {
  const files = readdirSync(modelDir) as string[];
  const hasEncoder = files.some((f: string) => f.includes('encoder'));
  const hasDecoder = files.some((f: string) => f.includes('decoder'));
  const hasJoiner = files.some((f: string) => f.includes('joiner'));

  let config: OnlineRecognizerConfig;

  if (hasEncoder && hasDecoder && hasJoiner) {
    // Transducer model (Zipformer, etc.)
    const encoder = files.find((f: string) => f.includes('encoder') && f.endsWith('.onnx'))!;
    const decoder = files.find((f: string) => f.includes('decoder') && f.endsWith('.onnx'))!;
    const joiner = files.find((f: string) => f.includes('joiner') && f.endsWith('.onnx'))!;
    config = {
      modelConfig: {
        transducer: {
          encoder: join(modelDir, encoder),
          decoder: join(modelDir, decoder),
          joiner: join(modelDir, joiner),
        },
        tokens: tokensPath,
        numThreads: 2,
        debug: false,
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    };
  } else {
    // CTC model
    const model = files.find((f: string) => f.endsWith('.onnx'))!;
    config = {
      modelConfig: {
        zipformer2Ctc: { model: join(modelDir, model) },
        tokens: tokensPath,
        numThreads: 2,
        debug: false,
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
    };
  }

  const recognizer = new SherpaOnnx.OnlineRecognizer(config);
  let stream: OnlineStream = recognizer.createStream();
  let lastText = '';

  return {
    feed(samples: Float32Array): string {
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }
      const result = recognizer.getResult(stream);
      lastText = result.text;
      return lastText;
    },

    finalize(): string {
      stream.inputFinished();
      while (recognizer.isReady(stream)) {
        recognizer.decode(stream);
      }
      const result = recognizer.getResult(stream);
      const text = result.text.trim();
      // Reset for next utterance.
      stream = recognizer.createStream();
      lastText = '';
      return text;
    },

    reset(): void {
      stream = recognizer.createStream();
      lastText = '';
    },
  };
}

// ── TTS ───────────────────────────────────────────────────────────────────────

export interface TtsEngine {
  /** Synthesize text into audio samples. */
  synthesize(text: string): { samples: Float32Array; sampleRate: number };
  /** Get the current voice ID. */
  currentVoice(): string;
  /** Switch to a different voice. Returns true if successful. */
  setVoice(entry: VoiceEntry): boolean;
  /** Sample rate of the current TTS model. */
  sampleRate(): number;
}

export function createTts(initialVoice: VoiceEntry): TtsEngine {
  let currentEntry = initialVoice;
  let tts: OfflineTts = buildTts(initialVoice);

  function buildTts(voice: VoiceEntry): OfflineTts {
    return new SherpaOnnx.OfflineTts({
      model: {
        vits: {
          model: voice.model,
          tokens: voice.tokens,
          dataDir: voice.dataDir,
          lexicon: voice.lexicon,
          lengthScale: 1.0,
        },
        numThreads: 2,
        debug: false,
      },
      maxNumSentences: 2,
    });
  }

  return {
    synthesize(text: string): { samples: Float32Array; sampleRate: number } {
      const audio = tts.generate({ text, sid: currentEntry.speakerId, speed: 1.0 });
      return { samples: audio.samples, sampleRate: audio.sampleRate };
    },

    currentVoice(): string {
      return currentEntry.id;
    },

    setVoice(entry: VoiceEntry): boolean {
      try {
        tts = buildTts(entry);
        currentEntry = entry;
        return true;
      } catch {
        return false;
      }
    },

    sampleRate(): number {
      return tts.sampleRate;
    },
  };
}
