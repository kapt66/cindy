/**
 * MCPRouter production default retained from XDMaker Meka.
 * Development and staging builds can override it without changing user settings.
 */
export const DEFAULT_MEKA_MCPROUTER_URL =
  import.meta.env.VITE_MEKA_MCPROUTER_URL?.trim() || 'http://172.25.135.168:1020/';
