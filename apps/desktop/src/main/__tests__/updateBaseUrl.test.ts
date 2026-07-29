import { describe, expect, it } from 'vitest';

import { resolveUpdateBaseUrl } from '../../shared/updateBaseUrl';

describe('resolveUpdateBaseUrl', () => {
  it('prefers an explicit runtime override', () => {
    expect(
      resolveUpdateBaseUrl({
        environmentOverride: 'https://override.example.test/root/',
        endpointCdnBaseUrl: 'https://manifest.example.test/root',
        endpointManifestBaseUrl: 'https://baked.example.test/cindy-meka',
      }),
    ).toBe('https://override.example.test/root');
  });

  it('uses the endpoint manifest CDN when configured', () => {
    expect(
      resolveUpdateBaseUrl({
        endpointCdnBaseUrl: 'https://manifest.example.test/root/',
        endpointManifestBaseUrl: 'https://baked.example.test/cindy-meka',
      }),
    ).toBe('https://manifest.example.test/root');
  });

  it('falls back to the baked manifest root for private Meka channels', () => {
    expect(
      resolveUpdateBaseUrl({
        endpointCdnBaseUrl: '',
        endpointManifestBaseUrl: 'https://s3.meka.pawdy.fun/cindy-meka/',
      }),
    ).toBe('https://s3.meka.pawdy.fun/cindy-meka');
  });
});
