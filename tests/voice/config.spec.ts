import { describe, expect, it } from 'vitest';
import { parseArgs, resolveVoice, validateModels } from '../../src/adapters/voice/config.ts';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function tempModels(): string {
  const dir = mkdtempSync(join(tmpdir(), 'voice-config-'));
  mkdirSync(join(dir, 'vad'), { recursive: true });
  mkdirSync(join(dir, 'stt'), { recursive: true });
  mkdirSync(join(dir, 'tts', 'default'), { recursive: true });
  writeFileSync(join(dir, 'vad', 'silero_vad.onnx'), 'fake');
  writeFileSync(join(dir, 'stt', 'tokens.txt'), 'fake');
  writeFileSync(
    join(dir, 'voices.yaml'),
    `- id: default
  label: Default
  model: default/model.onnx
  tokens: default/tokens.txt
  speakerId: 0
- id: amy
  label: Amy
  model: default/model.onnx
  tokens: default/tokens.txt
  speakerId: 1
`,
  );
  return dir;
}

describe('parseArgs', () => {
  it('extracts archive and defaults', () => {
    const models = tempModels();
    const config = parseArgs(['node', 'main.ts', '--archive', '/tmp/a', '--models', models]);
    expect(config.archive).toBe('/tmp/a');
    expect(config.mode).toBeUndefined();
    expect(config.voice).toBe('default');
  });

  it('extracts all flags', () => {
    const models = tempModels();
    const config = parseArgs([
      'node',
      'main.ts',
      '--archive',
      '/tmp/a',
      '--mode',
      'tutor',
      '--voice',
      'amy',
      '--models',
      models,
      '--input-device',
      'mic1',
      '--output-device',
      'spk1',
    ]);
    expect(config.mode).toBe('tutor');
    expect(config.voice).toBe('amy');
    expect(config.audioInputDevice).toBe('mic1');
    expect(config.audioOutputDevice).toBe('spk1');
  });
});

describe('resolveVoice', () => {
  it('finds a registered voice', () => {
    const models = tempModels();
    const config = parseArgs(['node', 'main.ts', '--archive', '/tmp/a', '--models', models]);
    const voice = resolveVoice(config, 'amy');
    expect(voice).toBeDefined();
    expect(voice!.id).toBe('amy');
    expect(voice!.speakerId).toBe(1);
  });

  it('returns undefined for unknown voice', () => {
    const models = tempModels();
    const config = parseArgs(['node', 'main.ts', '--archive', '/tmp/a', '--models', models]);
    expect(resolveVoice(config, 'nonexistent')).toBeUndefined();
  });
});

describe('validateModels', () => {
  it('returns empty when all models present', () => {
    const models = tempModels();
    const config = parseArgs(['node', 'main.ts', '--archive', '/tmp/a', '--models', models]);
    expect(validateModels(config)).toEqual([]);
  });

  it('reports missing models', () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-missing-'));
    const config = parseArgs(['node', 'main.ts', '--archive', '/tmp/a', '--models', dir]);
    const missing = validateModels(config);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.some((m) => m.includes('VAD'))).toBe(true);
  });
});
