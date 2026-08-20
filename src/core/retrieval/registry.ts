import type { Archive } from '../archive/archive.ts';
import { ArchiveIndex } from './index.ts';

/**
 * One index per archive, rebuilt when the archive has changed under it.
 *
 * Rebuilding is on demand rather than on a timer or a watcher. A session writes exactly one
 * file while it runs — its own transcript — and those turns are already in the model's
 * context, so nothing in the archive that retrieval could usefully see changes mid-session.
 * What does change is that a *finished* session becomes searchable, so closing one marks the
 * index stale and the next caller pays for the rebuild.
 *
 * The alternative, rebuilding in the background at session close, would make `session.end`
 * either slow or racy for no benefit anyone can observe.
 */
export class IndexRegistry {
  #entries = new Map<string, { index: ArchiveIndex; stale: boolean }>();

  async get(archive: Archive): Promise<ArchiveIndex> {
    const existing = this.#entries.get(archive.root);

    if (existing === undefined) {
      const index = await ArchiveIndex.build(archive.store);
      this.#entries.set(archive.root, { index, stale: false });
      return index;
    }

    if (!existing.stale) return existing.index;

    // Pass the old index so the generation counter keeps climbing: a groundedness report
    // naming generation 3 has to mean something different from one naming generation 2.
    const index = await ArchiveIndex.build(archive.store, existing.index);
    this.#entries.set(archive.root, { index, stale: false });
    return index;
  }

  /** Peek without building. Null when this archive has never been indexed. */
  peek(root: string): ArchiveIndex | null {
    return this.#entries.get(root)?.index ?? null;
  }

  isStale(root: string): boolean {
    return this.#entries.get(root)?.stale ?? false;
  }

  markStale(root: string): void {
    const existing = this.#entries.get(root);
    if (existing !== undefined) existing.stale = true;
  }

  forget(root: string): void {
    this.#entries.delete(root);
  }
}
