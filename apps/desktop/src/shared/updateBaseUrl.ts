export interface UpdateBaseUrlSources {
  environmentOverride?: string;
  endpointCdnBaseUrl?: string;
  endpointManifestBaseUrl?: string;
}

/**
 * The endpoint manifest remains authoritative when it declares a CDN root.
 * Private Meka deployments may omit that field and reuse their explicitly
 * baked endpoint-manifest root, including an opted-in intranet HTTP URL.
 */
export function resolveUpdateBaseUrl(sources: UpdateBaseUrlSources): string {
  return (
    sources.environmentOverride?.trim().replace(/\/+$/, '') ||
    sources.endpointCdnBaseUrl?.trim().replace(/\/+$/, '') ||
    sources.endpointManifestBaseUrl?.trim().replace(/\/+$/, '') ||
    ''
  );
}
