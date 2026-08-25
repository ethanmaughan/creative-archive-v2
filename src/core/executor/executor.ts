import { resolve } from 'node:path';
import { appendAudit, type AuditEntry } from '../capabilities/audit.ts';
import {
  assertCapabilityGranted,
  type Capabilities,
  type ExecuteGrant,
} from '../capabilities/validate.ts';
import type { FileStore } from '../storage/file-store.ts';
import { executeFileWrite } from './file-write.ts';
import { executeShell } from './shell.ts';
import { executeWebFetch } from './web-fetch.ts';

/**
 * The executor (§6.1, step 9): per-task, dies on completion.
 *
 * Each task is validated against the mode's capability manifest before execution. Every
 * exercise — successful or denied — is logged to the session's audit trail (§6.5).
 */

export type ExecutorTask =
  | { readonly type: 'file_write'; readonly path: string; readonly content: string }
  | {
      readonly type: 'shell';
      readonly command: string;
      readonly args?: readonly string[];
      readonly timeout?: number;
    }
  | { readonly type: 'web_fetch'; readonly url: string };

export interface ExecutorResult {
  readonly outcome: 'ok' | 'denied' | 'error';
  readonly output?: string | undefined;
  readonly error?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly durationMs: number;
}

/**
 * Run a task within the capability grant, logging to the audit trail.
 *
 * @param archiveRoot - Absolute path to the archive root, used to resolve `<archive>` in grants.
 */
export async function runTask(
  task: ExecutorTask,
  capabilities: Capabilities,
  store: FileStore,
  sessionId: string,
  archiveRoot: string,
): Promise<ExecutorResult> {
  const start = Date.now();

  try {
    switch (task.type) {
      case 'file_write':
        return await runFileWrite(task, capabilities, store, sessionId, archiveRoot, start);
      case 'shell':
        return await runShell(task, capabilities, store, sessionId, start);
      case 'web_fetch':
        return await runWebFetch(task, capabilities, store, sessionId, start);
    }
  } catch (error) {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      capability:
        task.type === 'file_write'
          ? 'fs_write'
          : task.type === 'shell'
            ? 'execute'
            : 'web_fetch',
      args: task,
      outcome: 'error',
      error: (error as Error).message,
    };
    await appendAudit(store, sessionId, entry);
    return {
      outcome: 'error',
      error: (error as Error).message,
      durationMs: Date.now() - start,
    };
  }
}

async function runFileWrite(
  task: Extract<ExecutorTask, { type: 'file_write' }>,
  capabilities: Capabilities,
  store: FileStore,
  sessionId: string,
  archiveRoot: string,
  start: number,
): Promise<ExecutorResult> {
  try {
    assertCapabilityGranted(capabilities, 'fs_write');
  } catch (error) {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      capability: 'fs_write',
      args: { path: task.path },
      outcome: 'denied',
      error: (error as Error).message,
    };
    await appendAudit(store, sessionId, entry);
    return {
      outcome: 'denied',
      error: (error as Error).message,
      durationMs: Date.now() - start,
    };
  }

  // Resolve <archive> placeholder in grant paths.
  const grantedPaths = (capabilities.fs_write as readonly string[]).map((p) =>
    resolve(p.replace(/<archive>/g, archiveRoot)),
  );

  const result = executeFileWrite(task.path, task.content, grantedPaths);

  const entry: AuditEntry = {
    at: new Date().toISOString(),
    capability: 'fs_write',
    args: { path: result.path, bytesWritten: result.bytesWritten },
    outcome: 'ok',
  };
  await appendAudit(store, sessionId, entry);

  return {
    outcome: 'ok',
    output: result.path,
    durationMs: Date.now() - start,
  };
}

async function runShell(
  task: Extract<ExecutorTask, { type: 'shell' }>,
  capabilities: Capabilities,
  store: FileStore,
  sessionId: string,
  start: number,
): Promise<ExecutorResult> {
  try {
    assertCapabilityGranted(capabilities, 'execute');
  } catch (error) {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      capability: 'execute',
      args: { command: task.command },
      outcome: 'denied',
      error: (error as Error).message,
    };
    await appendAudit(store, sessionId, entry);
    return {
      outcome: 'denied',
      error: (error as Error).message,
      durationMs: Date.now() - start,
    };
  }

  const grant = capabilities.execute as ExecuteGrant;
  const result = await executeShell(task.command, task.args ?? [], grant, task.timeout);

  const entry: AuditEntry = {
    at: new Date().toISOString(),
    capability: 'execute',
    args: { command: task.command, args: task.args, cwd: grant.cwd },
    outcome: result.exitCode === 0 ? 'ok' : 'error',
    error: result.exitCode !== 0 ? result.stderr.slice(0, 500) : undefined,
  };
  await appendAudit(store, sessionId, entry);

  return {
    outcome: result.exitCode === 0 ? 'ok' : 'error',
    output: result.stdout,
    error: result.stderr || undefined,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  };
}

async function runWebFetch(
  task: Extract<ExecutorTask, { type: 'web_fetch' }>,
  capabilities: Capabilities,
  store: FileStore,
  sessionId: string,
  start: number,
): Promise<ExecutorResult> {
  try {
    assertCapabilityGranted(capabilities, 'web_fetch');
  } catch (error) {
    const entry: AuditEntry = {
      at: new Date().toISOString(),
      capability: 'web_fetch',
      args: { url: task.url },
      outcome: 'denied',
      error: (error as Error).message,
    };
    await appendAudit(store, sessionId, entry);
    return {
      outcome: 'denied',
      error: (error as Error).message,
      durationMs: Date.now() - start,
    };
  }

  const result = await executeWebFetch(task.url);

  const entry: AuditEntry = {
    at: new Date().toISOString(),
    capability: 'web_fetch',
    args: { url: task.url, status: result.status },
    outcome: result.status >= 200 && result.status < 400 ? 'ok' : 'error',
    error: result.status >= 400 ? `HTTP ${result.status}` : undefined,
  };
  await appendAudit(store, sessionId, entry);

  return {
    outcome: result.status >= 200 && result.status < 400 ? 'ok' : 'error',
    output: result.body,
    error: result.status >= 400 ? `HTTP ${result.status}` : undefined,
    durationMs: result.durationMs,
  };
}
