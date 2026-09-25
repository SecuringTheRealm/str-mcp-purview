// str-mcp-purview — MCP server core for Microsoft Purview data security.
// Developed by Securing the Realm (https://securing.quest/):
// Chris Lloyd-Jones (Sealjay) & Josh McDonald (KnowledgeRatio).
// Licensed under MIT — this attribution notice must be retained (see LICENCE).
// MCP transport registration; capability implementations and metadata live separately.
import { Server, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { capabilities } from "./capabilities/registry.js";
import { createProjection, toolMode, searchLimit } from "./mcp/projection.js";
import { PROMPTS, getPrompt } from "./mcp/prompts.js";
import { policyFromEnvironment, permitted } from "./retrieval/filters.js";
import { executeCapability } from "./dispatch/execute.js";
import { createRequestLogger } from "./request-logging.js";
import { errorResult } from "./dispatch/errors.js";
import { indexCapabilities } from "./capabilities/contract.js";

// Compatibility exports for consumers that inspect the full surface.
export const TOOLS = capabilities.map((c) => c.tool);
export { PROMPTS };
const resourceCapabilities = {
  "purview://label-catalog": ["list_sensitivity_labels", {}],
  "purview://sit-catalog": ["list_sensitive_information_types", { scope: "all" }],
  "purview://sit-catalog/custom": ["list_sensitive_information_types", { scope: "custom" }],
};
export const RESOURCES = [
  { uri: "purview://label-catalog", name: "Sensitivity Labels", description: "First page of sensitivity labels. Use the matching capability with next_cursor for more.", mimeType: "text/markdown" },
  { uri: "purview://sit-catalog", name: "Sensitive Information Types (all)", description: "First page of sensitive information types. Use the matching capability with next_cursor for more.", mimeType: "text/markdown" },
  { uri: "purview://sit-catalog/custom", name: "Sensitive Information Types (custom only)", description: "First page of custom sensitive information types.", mimeType: "text/markdown" },
];

export function createServer(factoryContext = {}) {
  const entries = factoryContext.capabilities ?? capabilities;
  const registry = indexCapabilities(entries);
  // Caller restrictions must be supplied by a trusted host, never request arguments.
  // Server policy and caller policy are intersected, so callers cannot widen access.
  const serverPolicy = policyFromEnvironment();
  // Unspecified caller fields inherit server settings (notably enabled features).
  // Explicit caller fields can narrow them; the intersection below prevents widening.
  const callerPolicy = { ...serverPolicy, ...factoryContext.capabilityPolicy };
  const policy = {
    ...serverPolicy,
    allowedIds: entries.filter((c) => permitted(c, serverPolicy) && permitted(c, callerPolicy)).map((c) => c.id),
  };
  const mode = toolMode(factoryContext.toolMode ?? process.env.PURVIEW_TOOL_MODE ?? "full");
  const authorize = factoryContext.authorizeCapability;
  const projection = createProjection({ mode, policy, limit: searchLimit(), entries, authorize });
  const visibleResources = RESOURCES.filter((r) => policy.allowedIds.includes(resourceCapabilities[r.uri][0]));
  const withLogging = createRequestLogger({ transport: factoryContext.transport, era: factoryContext.era });
  const server = new Server(
    { name: "str-mcp-purview", version: "2.0.0" },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: projection.instructions,
      cacheHints: {
        "server/discover": { ttlMs: 0, cacheScope: "private" },
        "tools/list": { ttlMs: 0, cacheScope: "private" },
        "prompts/list": { ttlMs: 300_000, cacheScope: "public" },
        "resources/list": { ttlMs: 0, cacheScope: "private" },
        "resources/read": { ttlMs: 0, cacheScope: "private" },
      },
    }
  );
  server.setRequestHandler("tools/list", withLogging("tools/list", async () => ({ tools: projection.tools })));
  server.setRequestHandler("tools/call", withLogging("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    if (!projection.tools.some((tool) => tool.name === name)) {
      throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    try { return await projection.call(name, args ?? {}); }
    catch (error) { return errorResult(error); }
  }, (request) => ({ tool: request.params.name })));
  server.setRequestHandler("prompts/list", withLogging("prompts/list", async () => ({ prompts: PROMPTS })));
  server.setRequestHandler("prompts/get", withLogging("prompts/get", async (request) => {
    const result = getPrompt(request.params.name, request.params.arguments);
    if (mode !== "full") {
      result.messages.unshift({ role: "user", content: { type: "text", text: projection.instructions } });
    }
    return result;
  }, (request) => ({ prompt: request.params.name })));
  server.setRequestHandler("resources/list", withLogging("resources/list", async () => ({ resources: visibleResources })));
  server.setRequestHandler("resources/read", withLogging("resources/read", async (request) => {
    const { uri } = request.params;
    if (!visibleResources.some((r) => r.uri === uri)) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Resource unavailable or not permitted.");
    }
    const [id, args] = resourceCapabilities[uri];
    const result = await executeCapability(id, { ...args, limit: 25 }, policy, registry, authorize);
    const body = result.content.map((c) => c.text ?? "").join("\n");
    return { contents: [{ uri, mimeType: "text/markdown", text: body + "\n\nPagination: " + JSON.stringify(result.structuredContent && {
      count: result.structuredContent.count, total_count: result.structuredContent.total_count,
      next_cursor: result.structuredContent.next_cursor,
    }) + "\n" + projection.instructions }] };
  }, (request) => ({ resource: request.params.uri })));
  return server;
}
