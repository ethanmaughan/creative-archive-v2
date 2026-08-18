import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Invariant 2 (§2.1): the core has no knowledge of audio, and is fully exercisable
 * headlessly.
 *
 * "No knowledge of audio" is not testable by looking for the word — the core's comments
 * name the boundary on purpose. What is testable is the dependency direction: the core
 * never reaches an adapter, so no capability can quietly come to depend on one being
 * attached. The session tests prove the second half by driving a whole session through the
 * core's own API with no adapter in the process at all.
 */
describe('invariant: the core does not depend on any adapter', () => {
  const coreFiles = sourceFiles(join(REPO, 'src', 'core'));

  it('has core sources to check', () => {
    expect(coreFiles.length).toBeGreaterThan(15);
  });

  it('never imports from src/adapters', () => {
    for (const path of coreFiles) {
      const text = readFileSync(path, 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        expect(specifier.includes('adapters'), `${path} imports ${specifier}`).toBe(false);
      }
    }
  });

  it('lets adapters depend on the core, not the other way round', () => {
    const adapterFiles = sourceFiles(join(REPO, 'src', 'adapters'));
    const reachesCore = adapterFiles.some((path) =>
      readFileSync(path, 'utf8').includes("from '../../core/"),
    );
    expect(reachesCore).toBe(true);
  });

  it('pulls in no audio, speech, or media dependency', () => {
    const manifest = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['yaml', 'zod']);
  });

  it('keeps the protocol free of any audio concept, so one wire serves every adapter', () => {
    const protocol = readFileSync(join(REPO, 'src', 'protocol', 'messages.ts'), 'utf8');
    for (const term of ['transcribe', 'utteranceAudio', 'sampleRate', 'pcm', 'wav']) {
      expect(protocol.toLowerCase(), term).not.toContain(term.toLowerCase());
    }
  });
});
