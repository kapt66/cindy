/**
 * MCPRouter production default for the Caddy-terminated intranet endpoint.
 * Development and staging builds can override it with another credential-free
 * HTTPS origin without changing user settings.
 */
export const PRODUCTION_MEKA_MCPROUTER_URL = 'https://mcpr.meka.pawdy.fun/';

function readHttpsOverride(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return value.trim();
  } catch {
    return null;
  }
}

export const DEFAULT_MEKA_MCPROUTER_URL =
  readHttpsOverride(import.meta.env.VITE_MEKA_MCPROUTER_URL) ?? PRODUCTION_MEKA_MCPROUTER_URL;
