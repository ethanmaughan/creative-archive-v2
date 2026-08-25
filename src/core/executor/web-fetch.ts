/**
 * Web read executor (§6.1, step 9).
 *
 * Fetches a URL via GET. Read-only by design (§6.4) — POST, PUT, DELETE, and other mutating
 * methods are never used. Response content is labeled as untrusted: it is data, never
 * instruction, and cannot introduce or modify tool calls.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export interface WebFetchResult {
  readonly url: string;
  readonly status: number;
  readonly contentType: string | null;
  /** Response body, truncated to MAX_BODY_BYTES. Labeled untrusted (§6.4). */
  readonly body: string;
  readonly truncated: boolean;
  readonly durationMs: number;
}

export async function executeWebFetch(
  url: string,
  timeoutMs?: number,
): Promise<WebFetchResult> {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  const response = await fetch(url, {
    method: 'GET',
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
    headers: {
      'User-Agent': 'creative-archive-v2/executor',
      Accept: 'text/plain, text/html, application/json, */*',
    },
  });

  const buffer = await response.arrayBuffer();
  const truncated = buffer.byteLength > MAX_BODY_BYTES;
  const body = new TextDecoder().decode(truncated ? buffer.slice(0, MAX_BODY_BYTES) : buffer);

  return {
    url,
    status: response.status,
    contentType: response.headers.get('content-type'),
    body,
    truncated,
    durationMs: Date.now() - start,
  };
}
