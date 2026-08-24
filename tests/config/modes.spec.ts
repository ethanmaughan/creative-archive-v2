import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigInvalid, CoreError } from '../../src/core/errors.ts';
import {
  IMPLEMENTED_TOOLS,
  listModes,
  loadMode,
  loadModeFile,
} from '../../src/core/modes/mode.ts';

describe('shipped mode manifests', () => {
  it('loads the initial set from §3', async () => {
    const modes = await listModes();
    expect(modes.map((mode) => mode.id).sort()).toEqual([
      'creative',
      'review',
      'study-partner',
      'tutor',
    ]);
  });

  it('declares only implemented tools, and points at fragments that exist', async () => {
    for (const mode of await listModes()) {
      expect(mode.tools.length).toBeGreaterThan(0);
      for (const tool of mode.tools) {
        expect(IMPLEMENTED_TOOLS).toContain(tool);
      }
      expect(mode.promptFragmentPath).toMatch(/\.md$/);
      expect(mode.sessionTemplatePath).toMatch(/\.md$/);
    }
  });

  it('gives every mode a write scope narrower than its read scope', async () => {
    for (const mode of await listModes()) {
      expect(mode.scope.write).not.toEqual(mode.scope.read);
      expect(mode.scope.write).toEqual(['sessions/**']);
    }
  });

  it('declares capabilities on every shipped mode', async () => {
    for (const mode of await listModes()) {
      expect(mode.capabilities).toBeDefined();
      expect(mode.capabilities.execute).toBe(false);
      expect(mode.capabilities.web_fetch).toBe(false);
    }
  });

  it('names the available modes when asked for one that does not exist', async () => {
    await expect(loadMode('philosopher')).rejects.toThrow(/unknown mode 'philosopher'.*tutor/s);
    await expect(loadMode('philosopher')).rejects.toThrow(CoreError);
  });
});

describe('mode manifest validation', () => {
  let dir: string;

  const writeManifest = (body: string): string => {
    const path = join(dir, 'modes', 'probe.yaml');
    writeFileSync(path, body, 'utf8');
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ca2-modes-'));
    mkdirSync(join(dir, 'modes'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('accepts retrieve now that structural retrieval exists', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/tutor.md',
        'scope:',
        "  read: ['**']",
        "  write: ['sessions/**']",
        'tools: [retrieve, footnote]',
      ].join('\n'),
    );
    expect((await loadModeFile(path)).tools).toEqual(['retrieve', 'footnote']);
  });

  it('rejects a tool the core does not implement, rather than ignoring it', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/tutor.md',
        'scope:',
        "  read: ['**']",
        "  write: ['sessions/**']",
        'tools: [derive, footnote]',
      ].join('\n'),
    );
    await expect(loadModeFile(path)).rejects.toThrow(/unknown tool 'derive'/);
  });

  it('accepts a capabilities block now that step 8 enforces it', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/tutor.md',
        'scope:',
        "  read: ['**']",
        "  write: ['sessions/**']",
        'tools: [footnote]',
        'capabilities:',
        '  execute: false',
        '  model_call: { budget_usd_session: 2.00 }',
      ].join('\n'),
    );
    const mode = await loadModeFile(path);
    expect(mode.capabilities.execute).toBe(false);
    expect(mode.capabilities.model_call).toEqual({ budget_usd_session: 2.0 });
  });

  it('defaults to empty capabilities when block is omitted', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/tutor.md',
        'scope:',
        "  read: ['**']",
        "  write: ['sessions/**']",
        'tools: [footnote]',
      ].join('\n'),
    );
    const mode = await loadModeFile(path);
    expect(mode.capabilities).toEqual({});
  });

  it('rejects execute + web_fetch co-grant (§6.4)', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/tutor.md',
        'scope:',
        "  read: ['**']",
        "  write: ['sessions/**']",
        'tools: [footnote]',
        'capabilities:',
        '  execute: { cwd: /tmp, network: false }',
        '  web_fetch: { read_only: true }',
      ].join('\n'),
    );
    await expect(loadModeFile(path)).rejects.toThrow(/execute and web_fetch must not both/);
  });

  it('rejects web_fetch without read_only (§6.4)', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/tutor.md',
        'scope:',
        "  read: ['**']",
        "  write: ['sessions/**']",
        'tools: [footnote]',
        'capabilities:',
        '  web_fetch: { read_only: false }',
      ].join('\n'),
    );
    await expect(loadModeFile(path)).rejects.toThrow(/web_fetch must be read_only/);
  });

  it('rejects an unknown capability key', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/tutor.md',
        'scope:',
        "  read: ['**']",
        "  write: ['sessions/**']",
        'tools: [footnote]',
        'capabilities:',
        '  teleport: true',
      ].join('\n'),
    );
    await expect(loadModeFile(path)).rejects.toThrow(ConfigInvalid);
  });

  it('rejects an unknown key instead of silently dropping it', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/tutor.md',
        'scope:',
        "  read: ['**']",
        "  write: ['sessions/**']",
        'tools: [footnote]',
        'scoep:',
        "  read: ['**']",
      ].join('\n'),
    );
    await expect(loadModeFile(path)).rejects.toThrow(ConfigInvalid);
  });

  it('rejects a missing prompt fragment', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/nope.md',
        'scope:',
        "  read: ['**']",
        "  write: ['sessions/**']",
        'tools: [footnote]',
      ].join('\n'),
    );
    await expect(loadModeFile(path)).rejects.toThrow(/does not exist/);
  });

  it('requires a scope', async () => {
    const path = writeManifest(
      [
        'id: probe',
        'label: Probe',
        'prompt_fragment: prompts/modes/tutor.md',
        'tools: [footnote]',
      ].join('\n'),
    );
    await expect(loadModeFile(path)).rejects.toThrow(ConfigInvalid);
  });
});
