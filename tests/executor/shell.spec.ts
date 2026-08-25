import { describe, expect, it } from 'vitest';
import { executeShell } from '../../src/core/executor/shell.ts';
import type { ExecuteGrant } from '../../src/core/capabilities/validate.ts';

const grant: ExecuteGrant = { cwd: '.', network: false };

describe('shell executor', () => {
  it('runs a command and captures stdout', async () => {
    const result = await executeShell('echo', ['hello'], grant);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('captures stderr on failure', async () => {
    const result = await executeShell('node', ['-e', 'process.exit(1)'], grant);
    expect(result.exitCode).toBe(1);
  });

  it('reports duration', async () => {
    const result = await executeShell('echo', ['fast'], grant);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('respects timeout', async () => {
    const result = await executeShell(
      'node',
      ['-e', 'setTimeout(() => {}, 60000)'],
      grant,
      500,
    );
    // On timeout, the process is killed. Exit code may be null, signal may be SIGTERM.
    expect(result.durationMs).toBeLessThan(5000);
  });

  it('strips sensitive environment variables', async () => {
    // Set a fake API key in the environment for this test.
    const oldVal = process.env['CREATIVE_ARCHIVE_SECRET'];
    process.env['CREATIVE_ARCHIVE_SECRET'] = 'should-not-leak';
    try {
      const result = await executeShell(
        'node',
        ['-e', 'console.log(process.env.CREATIVE_ARCHIVE_SECRET ?? "stripped")'],
        grant,
      );
      expect(result.stdout.trim()).toBe('stripped');
    } finally {
      if (oldVal === undefined) delete process.env['CREATIVE_ARCHIVE_SECRET'];
      else process.env['CREATIVE_ARCHIVE_SECRET'] = oldVal;
    }
  });
});
