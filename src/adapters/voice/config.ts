import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/** Root of the repository, resolved from this file's location. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DEFAULT_MODELS_DIR = join(REPO_ROOT, 'models');

export interface VoiceEntry {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly tokens: string;
  readonly dataDir?: string | undefined;
  readonly lexicon?: string | undefined;
  readonly speakerId: number;
}

export interface VoiceConfig {
  readonly archive: string;
  readonly mode: string | undefined;
  readonly voice: string;
  readonly modelsDir: string;
  readonly vadModel: string;
  readonly sttDir: string;
  readonly sttTokens: string;
  readonly voices: ReadonlyArray<VoiceEntry>;
  readonly audioInputDevice: string | undefined;
  readonly audioOutputDevice: string | undefined;
}

export function parseArgs(argv: string[]): VoiceConfig {
  const args = argv.slice(2);
  const archive = valueOf(args, '--archive');
  const mode = valueOf(args, '--mode');
  const voice = valueOf(args, '--voice') ?? 'default';
  const modelsDir = valueOf(args, '--models') ?? DEFAULT_MODELS_DIR;
  const audioInputDevice = valueOf(args, '--input-device');
  const audioOutputDevice = valueOf(args, '--output-device');

  if (archive === undefined) {
    printUsage();
    process.exit(2);
  }

  const vadModel = join(modelsDir, 'vad', 'silero_vad.onnx');
  const sttDir = join(modelsDir, 'stt');
  const sttTokens = join(sttDir, 'tokens.txt');
  const voices = loadVoiceRegistry(modelsDir);

  return {
    archive,
    mode,
    voice,
    modelsDir,
    vadModel,
    sttDir,
    sttTokens,
    voices,
    audioInputDevice,
    audioOutputDevice,
  };
}

function loadVoiceRegistry(modelsDir: string): VoiceEntry[] {
  const registryPath = join(modelsDir, 'voices.yaml');
  if (!existsSync(registryPath)) return [];
  const raw = readFileSync(registryPath, 'utf8');
  const parsed = parseYaml(raw) as Array<Record<string, unknown>> | null;
  if (!Array.isArray(parsed)) return [];

  return parsed.map((entry) => ({
    id: String(entry['id'] ?? 'unknown'),
    label: String(entry['label'] ?? entry['id'] ?? 'unknown'),
    model: resolve(modelsDir, 'tts', String(entry['model'] ?? '')),
    tokens: resolve(modelsDir, 'tts', String(entry['tokens'] ?? '')),
    dataDir:
      entry['dataDir'] !== undefined
        ? resolve(modelsDir, 'tts', String(entry['dataDir']))
        : undefined,
    lexicon:
      entry['lexicon'] !== undefined
        ? resolve(modelsDir, 'tts', String(entry['lexicon']))
        : undefined,
    speakerId: Number(entry['speakerId'] ?? 0),
  }));
}

export function resolveVoice(config: VoiceConfig, voiceId: string): VoiceEntry | undefined {
  return config.voices.find((v) => v.id === voiceId);
}

export function validateModels(config: VoiceConfig): string[] {
  const missing: string[] = [];
  if (!existsSync(config.vadModel)) missing.push(`VAD model: ${config.vadModel}`);
  if (!existsSync(config.sttDir)) missing.push(`STT model directory: ${config.sttDir}`);
  if (!existsSync(config.sttTokens)) missing.push(`STT tokens: ${config.sttTokens}`);
  return missing;
}

function printUsage(): void {
  console.error(`usage: voice --archive <path> [options]

options:
  --archive <path>         Archive directory (required)
  --mode <id>              Mode to use (tutor, creative, review, study-partner)
  --voice <id>             TTS voice ID from voices.yaml (default: "default")
  --models <dir>           Models directory (default: <repo>/models/)
  --input-device <name>    Audio input device name (default: system default)
  --output-device <name>   Audio output device name (default: system default)

required models (download to <models-dir>/):
  vad/silero_vad.onnx      Silero VAD model (~2 MB)
  stt/                     Streaming STT model directory (encoder, decoder, joiner, tokens.txt)
  tts/                     TTS voice model directories
  voices.yaml              Voice registry mapping IDs to model paths

voices.yaml example:
  - id: default
    label: "Default English"
    model: default/model.onnx
    tokens: default/tokens.txt
    dataDir: default/espeak-ng-data`);
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}
