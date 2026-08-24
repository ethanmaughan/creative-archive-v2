import { describe, expect, it } from 'vitest';
import { ConfigInvalid, CoreError } from '../../src/core/errors.ts';
import {
  assertCapabilityGranted,
  capabilitySummary,
  validateCapabilityCombinations,
  type Capabilities,
} from '../../src/core/capabilities/validate.ts';

describe('capability validation (§6.3, §6.4)', () => {
  it('assertCapabilityGranted passes for a granted capability', () => {
    const caps: Capabilities = { fs_read: ['**'] };
    expect(() => assertCapabilityGranted(caps, 'fs_read')).not.toThrow();
  });

  it('assertCapabilityGranted throws for an ungranted capability', () => {
    const caps: Capabilities = {};
    expect(() => assertCapabilityGranted(caps, 'execute')).toThrow(CoreError);
    expect(() => assertCapabilityGranted(caps, 'execute')).toThrow(/not granted/);
  });

  it('assertCapabilityGranted throws for an explicitly denied capability', () => {
    const caps: Capabilities = { execute: false };
    expect(() => assertCapabilityGranted(caps, 'execute')).toThrow(/not granted/);
  });

  it('validateCapabilityCombinations rejects execute + web_fetch co-grant', () => {
    const caps: Capabilities = {
      execute: { cwd: '/tmp', network: false },
      web_fetch: { read_only: true },
    };
    expect(() => validateCapabilityCombinations(caps, 'test')).toThrow(ConfigInvalid);
    expect(() => validateCapabilityCombinations(caps, 'test')).toThrow(
      /execute and web_fetch must not both/,
    );
  });

  it('validateCapabilityCombinations accepts execute alone', () => {
    const caps: Capabilities = { execute: { cwd: '/tmp', network: false } };
    expect(() => validateCapabilityCombinations(caps, 'test')).not.toThrow();
  });

  it('validateCapabilityCombinations accepts web_fetch alone (read_only)', () => {
    const caps: Capabilities = { web_fetch: { read_only: true } };
    expect(() => validateCapabilityCombinations(caps, 'test')).not.toThrow();
  });

  it('validateCapabilityCombinations rejects web_fetch without read_only', () => {
    const caps: Capabilities = { web_fetch: { read_only: false } };
    expect(() => validateCapabilityCombinations(caps, 'test')).toThrow(
      /web_fetch must be read_only/,
    );
  });

  it('validateCapabilityCombinations accepts empty capabilities', () => {
    expect(() => validateCapabilityCombinations({}, 'test')).not.toThrow();
  });

  it('validateCapabilityCombinations accepts all-false capabilities', () => {
    const caps: Capabilities = {
      execute: false,
      model_call: false,
      web_fetch: false,
    };
    expect(() => validateCapabilityCombinations(caps, 'test')).not.toThrow();
  });

  it('capabilitySummary produces readable output', () => {
    const caps: Capabilities = {
      fs_read: ['**'],
      execute: false,
      model_call: { budget_usd_session: 1.0 },
    };
    const summary = capabilitySummary(caps);
    expect(summary).toContain('fs_read');
    expect(summary).toContain('execute: denied');
    expect(summary).toContain('model_call');
  });

  it('capabilitySummary returns "none" for empty capabilities', () => {
    expect(capabilitySummary({})).toBe('none');
  });
});
