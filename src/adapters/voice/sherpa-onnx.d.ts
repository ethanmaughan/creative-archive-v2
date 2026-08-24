/**
 * Type declarations for sherpa-onnx-node.
 *
 * sherpa-onnx-node is a CommonJS native addon with no bundled types. These declarations cover
 * the subset the voice adapter uses: VAD, streaming STT, and offline TTS.
 */

declare module 'sherpa-onnx-node' {
  // ── Common ──────────────────────────────────────────────────────────────────

  interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  // ── VAD ─────────────────────────────────────────────────────────────────────

  interface SileroVadConfig {
    model: string;
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    windowSize?: number;
    maxSpeechDuration?: number;
  }

  interface VadConfig {
    sileroVad: SileroVadConfig;
    sampleRate: number;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }

  interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }

  class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    pop(): void;
    clear(): void;
    reset(): void;
    flush(): void;
  }

  // ── Online (streaming) STT ──────────────────────────────────────────────────

  interface OnlineTransducerModelConfig {
    encoder: string;
    decoder: string;
    joiner: string;
  }

  interface OnlineZipformer2CtcModelConfig {
    model: string;
  }

  interface OnlineParaformerModelConfig {
    encoder: string;
    decoder: string;
  }

  interface OnlineModelConfig {
    transducer?: OnlineTransducerModelConfig;
    paraformer?: OnlineParaformerModelConfig;
    zipformer2Ctc?: OnlineZipformer2CtcModelConfig;
    tokens: string;
    numThreads?: number;
    debug?: boolean | number;
    provider?: string;
    modelType?: string;
  }

  interface OnlineRecognizerConfig {
    featConfig?: { sampleRate?: number; featureDim?: number };
    modelConfig: OnlineModelConfig;
    decodingMethod?: string;
    maxActivePaths?: number;
    enableEndpoint?: boolean | number;
    rule1MinTrailingSilence?: number;
    rule2MinTrailingSilence?: number;
    rule3MinUtteranceLength?: number;
    hotwordsFile?: string;
    hotwordsScore?: number;
    blankPenalty?: number;
  }

  interface OnlineRecognizerResult {
    text: string;
    tokens: string[];
    timestamps: number[];
    segment: number;
    is_final: boolean;
    is_eof: boolean;
  }

  class OnlineStream {
    acceptWaveform(waveform: Waveform): void;
    inputFinished(): void;
  }

  class OnlineRecognizer {
    constructor(config: OnlineRecognizerConfig);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    isEndpoint(stream: OnlineStream): boolean;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): OnlineRecognizerResult;
  }

  // ── Offline TTS ─────────────────────────────────────────────────────────────

  interface VitsModelConfig {
    model: string;
    lexicon?: string | undefined;
    tokens: string;
    dataDir?: string | undefined;
    noiseScale?: number;
    noiseScaleW?: number;
    lengthScale?: number;
  }

  interface OfflineTtsModelConfig {
    vits?: VitsModelConfig;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }

  interface OfflineTtsConfig {
    model: OfflineTtsModelConfig;
    maxNumSentences?: number;
    silenceScale?: number;
  }

  interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  interface TtsRequest {
    text: string;
    sid: number;
    speed: number;
    enableExternalBuffer?: boolean;
  }

  class OfflineTts {
    constructor(config: OfflineTtsConfig);
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    readonly numSpeakers: number;
    readonly sampleRate: number;
    generate(request: TtsRequest): GeneratedAudio;
    generateAsync(
      request: TtsRequest & {
        onProgress?: (info: { samples: Float32Array; progress: number }) => void | boolean | 0;
      },
    ): Promise<GeneratedAudio>;
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  function readWave(filename: string, enableExternalBuffer?: boolean): Waveform;
  function writeWave(filename: string, waveform: Waveform): boolean;

  class LinearResampler {
    constructor(
      inputSampleRate: number,
      outputSampleRate: number,
      filterCutoffHz: number,
      numZeros: number,
    );
    resample(samples: Float32Array, flush?: boolean): Float32Array;
  }
}
