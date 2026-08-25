import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeFileWrite } from '../../src/core/executor/file-write.ts';

describe('file write executor', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ca2-fw-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a file to a granted path', () => {
    const target = join(dir, 'output', 'hello.txt');
    const result = executeFileWrite(target, 'hello world', [`${dir}/**`]);

    expect(result.bytesWritten).toBe(11);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('hello world');
  });

  it('creates parent directories as needed', () => {
    const target = join(dir, 'deep', 'nested', 'dir', 'file.md');
    executeFileWrite(target, '# Title', [`${dir}/**`]);
    expect(readFileSync(target, 'utf8')).toBe('# Title');
  });

  it('rejects a path outside the grant', () => {
    const target = join(tmpdir(), 'outside-grant.txt');
    expect(() => executeFileWrite(target, 'nope', [`${dir}/**`])).toThrow(
      /not within the fs_write grant/,
    );
  });

  it('rejects when grant is empty', () => {
    const target = join(dir, 'file.txt');
    expect(() => executeFileWrite(target, 'nope', [])).toThrow(/not within the fs_write grant/);
  });

  it('returns the absolute path written', () => {
    const target = join(dir, 'result.txt');
    const result = executeFileWrite(target, 'data', [`${dir}/**`]);
    expect(result.path).toContain(dir);
  });
});
