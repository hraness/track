/**
 * The ceiling for the tool catalog the model reads (`renderToolCatalog()`
 * length, in characters). The real cap is XCB_LIMITS.maxInputBytes (1 MiB)
 * and the gateway's request budget; this keeps the catalog a small share of
 * every request. Measured 56 109 after agentcore-0 trimmed the descriptions
 * into AGENT_TOOL_DOCS (src/agent/tool-docs.ts); new tools keep their
 * descriptions to one or two sentences and put the rest there.
 */
export const CATALOG_BUDGET = 72_000;
