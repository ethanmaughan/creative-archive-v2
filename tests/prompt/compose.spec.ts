import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configRoot } from '../../src/core/config/paths.ts';
import { DEFAULT_IDENTITY } from '../../src/core/identity/identity.ts';
import { PERSONALITY_IDS, loadPersonality } from '../../src/core/identity/personality.ts';
import { listModes, loadMode } from '../../src/core/modes/mode.ts';
import {
  PART_SEPARATOR,
  archiveContextBlock,
  buildSystemPrompt,
  composeSystemPrompt,
} from '../../src/core/prompt/compose.ts';

const ARCHIVE = '/tmp/example-archive';

describe('composeSystemPrompt', () => {
  it('is a pure concatenation of the five §4.3 fragments, in order', () => {
    const parts = {
      base: 'BASE',
      mode: 'MODE',
      personality: 'PERSONALITY',
      identity: 'IDENTITY',
      archiveContext: 'CONTEXT',
    };
    expect(composeSystemPrompt(parts)).toBe(
      ['BASE', 'MODE', 'PERSONALITY', 'IDENTITY', 'CONTEXT'].join(PART_SEPARATOR),
    );
  });
});

describe('buildSystemPrompt', () => {
  it('composes every mode against every personality', async () => {
    const modes = await listModes();
    expect(modes.length * PERSONALITY_IDS.length).toBe(20);

    for (const mode of modes) {
      for (const personality of PERSONALITY_IDS) {
        const { prompt } = await buildSystemPrompt({
          archiveRoot: ARCHIVE,
          mode,
          identity: { name: 'Alena', personality },
        });
        expect(prompt).toContain(`## Mode: ${mode.id}`);
        expect(prompt.length).toBeGreaterThan(200);
      }
    }
  });

  it('changes only the personality fragment when the preset changes', async () => {
    const mode = await loadMode('tutor');
    const plain = await buildSystemPrompt({
      archiveRoot: ARCHIVE,
      mode,
      identity: { name: 'Alena', personality: 'plain' },
    });
    const warm = await buildSystemPrompt({
      archiveRoot: ARCHIVE,
      mode,
      identity: { name: 'Alena', personality: 'warm' },
    });

    expect(warm.parts.personality).not.toBe(plain.parts.personality);
    expect(warm.parts.base).toBe(plain.parts.base);
    expect(warm.parts.mode).toBe(plain.parts.mode);
    expect(warm.parts.identity).toBe(plain.parts.identity);
    expect(warm.parts.archiveContext).toBe(plain.parts.archiveContext);
  });

  it('puts the name in the identity block only, never in the mode or personality fragment', async () => {
    const mode = await loadMode('creative');
    const { parts } = await buildSystemPrompt({
      archiveRoot: ARCHIVE,
      mode,
      identity: { name: 'Wintermute', personality: 'dry' },
    });

    expect(parts.identity).toContain('Wintermute');
    expect(parts.base).not.toContain('Wintermute');
    expect(parts.mode).not.toContain('Wintermute');
    expect(parts.personality).not.toContain('Wintermute');
  });

  it('defaults identity to the plain preset', async () => {
    const mode = await loadMode('review');
    const { parts } = await buildSystemPrompt({
      archiveRoot: ARCHIVE,
      mode,
      identity: DEFAULT_IDENTITY,
    });
    expect(parts.personality).toBe(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(loadPersonality('plain').promptFragmentPath, 'utf8'),
      ),
    );
  });
});

describe('invariant 4: no mode×personality combination exists', () => {
  it('keeps mode and personality fragments in separate directories', () => {
    const modeFragments = readdirSync(join(configRoot(), 'prompts', 'modes'));
    const personalityFragments = readdirSync(join(configRoot(), 'prompts', 'personalities'));

    // A file whose name carries both a mode id and a personality id would be a
    // hand-written combination — the thing §4.3 forbids.
    for (const name of [...modeFragments, ...personalityFragments]) {
      const namesAMode = ['tutor', 'creative', 'review', 'study-partner'].some((id) =>
        name.includes(id),
      );
      const namesAPersonality = PERSONALITY_IDS.some((id) => name.includes(id));
      expect(namesAMode && namesAPersonality, name).toBe(false);
    }
  });

  it('never mentions a personality preset inside a mode fragment', async () => {
    const fs = await import('node:fs/promises');
    for (const mode of await listModes()) {
      const text = await fs.readFile(mode.promptFragmentPath, 'utf8');
      for (const preset of PERSONALITY_IDS) {
        // `plain` is ordinary English ("say so plainly"); the others are only preset names.
        if (preset === 'plain') continue;
        expect(text.toLowerCase(), `${mode.id} names preset ${preset}`).not.toContain(preset);
      }
    }
  });
});

describe('archiveContextBlock', () => {
  it('forbids groundedness claims while there is no retrieval tool', async () => {
    const mode = await loadMode('tutor');
    const block = archiveContextBlock({
      archiveRoot: ARCHIVE,
      mode,
      retrievalAvailable: false,
    });
    expect(block).toContain('no retrieval tool');
    expect(block).toMatch(/may not report a gap/);
  });

  it('drops the warning once retrieval exists', async () => {
    const mode = await loadMode('tutor');
    const block = archiveContextBlock({ archiveRoot: ARCHIVE, mode, retrievalAvailable: true });
    expect(block).not.toContain('no retrieval tool');
    expect(block).toContain('example-archive');
  });
});
