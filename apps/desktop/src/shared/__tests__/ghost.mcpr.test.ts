import { describe, expect, it } from 'vitest';

import {
  isMcprRoutePattern,
  mcprRouteMatches,
  MCPR_CAPABILITY_CONTRACT_VERSION,
} from '../mcpr-plugin-capability';
import { ghostContentKeys, ghostPermissionItems, validateGhostManifest } from '../ghost';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'mcpr-plugin',
    name: 'MCPRouter plugin',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['mcpr'],
    mcpr: { routes: ['mcp.tools.list', 'meka.design.*'] },
    ...overrides,
  };
}

describe('mcpr plugin contract', () => {
  it('accepts exact and final-segment wildcard route patterns', () => {
    expect(isMcprRoutePattern('mcp.tools.list')).toBe(true);
    expect(isMcprRoutePattern('meka.design.*')).toBe(true);
    expect(isMcprRoutePattern('meka.*.design')).toBe(false);
    expect(isMcprRoutePattern('*')).toBe(false);
    expect(isMcprRoutePattern('meka/design')).toBe(false);
  });

  it('matches only the declared namespace suffix', () => {
    expect(mcprRouteMatches('meka.design.*', 'meka.design.create')).toBe(true);
    expect(mcprRouteMatches('meka.design.*', 'meka.design')).toBe(false);
    expect(mcprRouteMatches('meka.design.*', 'meka.asset.create')).toBe(false);
  });

  it('requires a route allowlist whenever the mcpr slot is declared', () => {
    expect(validateGhostManifest(manifest()).ok).toBe(true);
    expect(validateGhostManifest(manifest({ mcpr: undefined })).ok).toBe(false);
    expect(validateGhostManifest(manifest({ slots: ['tool'] })).ok).toBe(false);
    expect(
      validateGhostManifest(manifest({ mcpr: { routes: ['meka.design.*', 'meka.design.*'] } })).ok,
    ).toBe(false);
    expect(validateGhostManifest(manifest({ mcpr: { routes: ['https://example.test'] } })).ok).toBe(
      false,
    );
  });

  it('exposes mcpr in the permission and content projections', () => {
    const result = validateGhostManifest(manifest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ghostContentKeys(result.manifest)).toContain('slotMcpr');
    expect(ghostPermissionItems(result.manifest)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'mcpr', kind: 'mcpr' }),
        expect.objectContaining({
          key: 'mcpr:route:mcp.tools.list',
          labelArgs: { route: 'mcp.tools.list' },
        }),
      ]),
    );
  });

  it('keeps the wire contract version explicit', () => {
    expect(MCPR_CAPABILITY_CONTRACT_VERSION).toBe(1);
  });
});
