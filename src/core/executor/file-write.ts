import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { matchesAnyGlob } from '../storage/glob.ts';

/**
 * File generation executor (§6.1, step 9).
 *
 * Writes files to paths outside the archive, validated against the `fs_write` capability
 * grant. The archive's own files are handled by `ScopedFileStore` — this is for project
 * output, generated code, exported artifacts.
 */

export interface FileWriteResult {
  readonly path: string;
  readonly bytesWritten: number;
}

/**
 * Write content to a file, validating the path against granted globs.
 *
 * Paths in the `fs_write` grant may use `<archive>` as a placeholder for the archive root.
 * Callers resolve that before passing `grantedPaths` here.
 */
export function executeFileWrite(
  targetPath: string,
  content: string,
  grantedPaths: readonly string[],
): FileWriteResult {
  const absolute = resolve(targetPath);
  // Normalize to forward slashes for glob matching (the glob matcher uses POSIX paths).
  const normalized = absolute.replace(/\\/g, '/');
  const normalizedGrants = grantedPaths.map((p) => resolve(p).replace(/\\/g, '/'));

  // Validate against granted globs. The grant uses absolute paths (resolved by the caller).
  if (!matchesAnyGlob(normalizedGrants, normalized)) {
    throw new Error(
      `path '${absolute}' is not within the fs_write grant (${grantedPaths.join(', ')})`,
    );
  }

  mkdirSync(dirname(absolute), { recursive: true });
  const buffer = Buffer.from(content, 'utf8');
  writeFileSync(absolute, buffer);
  return { path: absolute, bytesWritten: buffer.length };
}
