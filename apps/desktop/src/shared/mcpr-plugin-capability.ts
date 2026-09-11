/**
 * Meka Desktop compatibility import for the shared MCPRouter plugin contract.
 * The in-repo `@cindy/plugin-protocol` package owns the contract; Desktop
 * callers keep this local path to avoid a broad import churn.
 */
export * from '@cindy/plugin-protocol/mcpr-plugin-capability';
