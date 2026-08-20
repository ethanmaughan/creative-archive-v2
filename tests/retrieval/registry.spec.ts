import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexRegistry } from '../../src/core/retrieval/registry.ts';
import { makeSandbox, type Sandbox } from '../helpers/sandbox.ts';

describe('IndexRegistry', () => {
  let sandbox: Sandbox;
  let registry: IndexRegistry;

  beforeEach(() => {
    sandbox = makeSandbox('ca2-registry');
    registry = new IndexRegistry();
  });

  afterEach(() => {
    sandbox.cleanup();
  });

  it('builds once and reuses the same index', async () => {
    const archive = await sandbox.open();
    const first = await registry.get(archive);
    const second = await registry.get(archive);

    expect(second).toBe(first);
    expect(second.generation).toBe(1);
  });

  it('does not notice a change on its own', async () => {
    const archive = await sandbox.open();
    await registry.get(archive);
    await archive.store.write('notes/new.md', '## New\n\nfresh material\n');

    // No watcher by design: nothing has told the registry anything changed.
    expect((await registry.get(archive)).documents).toBe(0);
  });

  it('rebuilds when told the archive changed, and advances the generation', async () => {
    const archive = await sandbox.open();
    await registry.get(archive);
    await archive.store.write('notes/new.md', '## New\n\nfresh material\n');

    registry.markStale(archive.root);
    expect(registry.isStale(archive.root)).toBe(true);

    const rebuilt = await registry.get(archive);
    expect(rebuilt.documents).toBe(1);
    expect(rebuilt.generation).toBe(2);
    expect(registry.isStale(archive.root)).toBe(false);
  });

  it('rebuilds only once for a run of stale marks', async () => {
    const archive = await sandbox.open();
    await registry.get(archive);
    registry.markStale(archive.root);
    registry.markStale(archive.root);

    expect((await registry.get(archive)).generation).toBe(2);
    expect((await registry.get(archive)).generation).toBe(2);
  });

  it('peeks without building', async () => {
    const archive = await sandbox.open();
    expect(registry.peek(archive.root)).toBeNull();
    await registry.get(archive);
    expect(registry.peek(archive.root)?.generation).toBe(1);
  });

  it('keeps archives independent', async () => {
    const other = makeSandbox('ca2-registry-two');
    try {
      const one = await sandbox.open();
      const two = await other.open();
      await registry.get(one);
      await registry.get(two);

      registry.markStale(one.root);
      expect(registry.isStale(one.root)).toBe(true);
      expect(registry.isStale(two.root)).toBe(false);
    } finally {
      other.cleanup();
    }
  });
});
