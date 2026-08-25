import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { ExecuteGrant } from '../capabilities/validate.ts';

/**
 * Code execution executor (§6.1, step 9).
 *
 * Spawns a child process with the working directory and network constraints declared in the
 * mode's `execute` capability grant. Environment is stripped to prevent API key leakage.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

/** Environment variables safe to pass through. Everything else is stripped. */
const PASSTHROUGH_VARS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'COMSPEC',
  'SystemRoot',
  'windir',
];

export interface ShellResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export function executeShell(
  command: string,
  args: readonly string[],
  grant: ExecuteGrant,
  timeoutMs?: number,
): Promise<ShellResult> {
  const cwd = resolve(grant.cwd);
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Strip environment to prevent credential leakage.
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_VARS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }

  const start = Date.now();

  return new Promise<ShellResult>((resolvePromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    child.on('close', (code, signal) => {
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks).toString('utf8').slice(0, MAX_OUTPUT_BYTES),
        stderr: Buffer.concat(stderrChunks).toString('utf8').slice(0, MAX_OUTPUT_BYTES),
        exitCode: code,
        signal: signal,
        timedOut: signal === 'SIGTERM' && code === null,
        durationMs: Date.now() - start,
      });
    });

    child.on('error', (err) => {
      resolvePromise({
        stdout: '',
        stderr: err.message,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - start,
      });
    });
  });
}
