/**
 * Meka Desktop compatibility import for the shared MCPRouter plugin contract.
 * The protocol submodule is the single source of truth; existing Desktop
 * callers keep this local path to avoid a broad import churn.
 */
export * from '@cindy/plugin-protocol';
