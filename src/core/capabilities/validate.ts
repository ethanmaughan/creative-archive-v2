import { ConfigInvalid, CoreError } from '../errors.ts';

/**
 * Capability validation (§6.3, §6.4).
 *
 * Capabilities are declared in the mode manifest and validated at load. A declared capability
 * is real — which is why the loader rejected the block until the enforcement was ready.
 */

export interface ExecuteGrant {
  readonly cwd: string;
  readonly network: boolean;
}

export interface ModelCallGrant {
  readonly budget_usd_session: number;
}

export interface WebFetchGrant {
  readonly read_only: boolean;
}

export interface Capabilities {
  readonly fs_read?: readonly string[] | undefined;
  readonly fs_write?: readonly string[] | undefined;
  readonly execute?: ExecuteGrant | false | undefined;
  readonly model_call?: ModelCallGrant | false | undefined;
  readonly web_fetch?: WebFetchGrant | false | undefined;
}

/** Known capability names, for validation. */
export const CAPABILITY_NAMES = [
  'fs_read',
  'fs_write',
  'execute',
  'model_call',
  'web_fetch',
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/**
 * §6.4 guardrails, enforced at mode load:
 *
 * - `web_fetch` and `execute` must not both be truthy (never co-granted to the same executor)
 * - `web_fetch` when granted must be `{ read_only: true }` (no network-write capability)
 */
export function validateCapabilityCombinations(
  capabilities: Capabilities,
  source: string,
): void {
  const hasExecute = capabilities.execute !== undefined && capabilities.execute !== false;
  const hasWebFetch = capabilities.web_fetch !== undefined && capabilities.web_fetch !== false;

  if (hasExecute && hasWebFetch) {
    throw new ConfigInvalid(
      source,
      'execute and web_fetch must not both be granted — §6.4 prohibits combining ' +
        'execution with fetched untrusted content in the same executor instance',
    );
  }

  if (hasWebFetch) {
    const grant = capabilities.web_fetch as WebFetchGrant;
    if (!grant.read_only) {
      throw new ConfigInvalid(
        source,
        'web_fetch must be read_only — §6.4 prohibits co-granting web_fetch and network-write',
      );
    }
  }
}

/** Throw if a capability is not granted by this mode's manifest. */
export function assertCapabilityGranted(
  capabilities: Capabilities,
  capability: CapabilityName,
): void {
  const value = capabilities[capability];
  if (value === undefined || value === false) {
    throw new CoreError(
      'capability_denied',
      `capability '${capability}' is not granted by this mode (§6.3)`,
    );
  }
}

/** Human-readable summary for logging. */
export function capabilitySummary(capabilities: Capabilities): string {
  const parts: string[] = [];
  for (const name of CAPABILITY_NAMES) {
    const value = capabilities[name];
    if (value === undefined) continue;
    if (value === false) {
      parts.push(`${name}: denied`);
    } else if (Array.isArray(value)) {
      parts.push(`${name}: [${value.join(', ')}]`);
    } else {
      parts.push(`${name}: ${JSON.stringify(value)}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'none';
}
