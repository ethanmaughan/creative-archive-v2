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

  it('rejects a deferred tool by name rather than ignoring it', async () => {
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
    await expect(loadModeFile(path)).rejects.toThrow(/tool 'retrieve' is not implemented/);
  });

  it('rejects a capabilities block, which nothing enforces until step 8', async () => {
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
      ].join('\n'),
    );
    await expect(loadModeFile(path)).rejects.toThrow(/'capabilities' is not enforced yet/);
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
