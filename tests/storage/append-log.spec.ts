import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppendLog } from '../../src/core/storage/append-log.ts';

describe('AppendLog', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ca2-append-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('makes each append visible on disk before it returns', () => {
    const path = join(root, 'nested/transcript.md');
    const log = AppendLog.open(path);

    log.append('first\n');
    // No sync, no close — the bytes are already out of the process.
    expect(readFileSync(path, 'utf8')).toBe('first\n');

    log.append('second\n');
    expect(readFileSync(path, 'utf8')).toBe('first\nsecond\n');

    log.close();
  });

  it('appends to an existing file rather than truncating it', () => {
    const path = join(root, 'transcript.md');
    writeFileSync(path, 'existing\n');

    const log = AppendLog.open(path);
    log.appendAndSync('appended\n');
    log.close();

    expect(readFileSync(path, 'utf8')).toBe('existing\nappended\n');
  });

  it('never interleaves badly when two handles hold the same file open', () => {
    // O_APPEND means a recovered process re-opening a transcript cannot clobber history.
    const path = join(root, 'transcript.md');
    const a = AppendLog.open(path);
    const b = AppendLog.open(path);

    a.append('aaa\n');
    b.append('bbb\n');
    a.append('ccc\n');

    a.close();
    b.close();

    expect(readFileSync(path, 'utf8')).toBe('aaa\nbbb\nccc\n');
  });

  it('writes multi-byte characters whole', () => {
    const path = join(root, 'transcript.md');
    const log = AppendLog.open(path);
    log.appendAndSync('héllo — “curly” ✍️\n');
    log.close();
    expect(readFileSync(path, 'utf8')).toBe('héllo — “curly” ✍️\n');
  });

  it('refuses to write after close', () => {
    const log = AppendLog.open(join(root, 'transcript.md'));
    log.close();
    expect(log.isOpen).toBe(false);
    expect(() => log.append('x')).toThrow(/closed/);
  });
});
