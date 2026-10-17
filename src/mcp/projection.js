import { capabilities } from "../capabilities/registry.js";
import { filterCapabilities } from "../retrieval/filters.js";
import { rankCapabilities } from "../retrieval/bm25.js";
import { executeCapability, validateArguments } from "../dispatch/execute.js";
import { indexCapabilities } from "../capabilities/contract.js";
import { permitted } from "../retrieval/filters.js";
import { CapabilityError } from "../dispatch/errors.js";

const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const argumentObject = { type: "object", additionalProperties: true, description: "Arguments matching input_schema from purview_describe_capability. Validated before execution." };
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const groups = [
  ["purview_labels", "labels", "read", "Inspect sensitivity labels, publishing policies, auto-label policies/rules and simulation diagnostics."],
  ["purview_manage_labels", "labels", "write", "Create, modify or delete sensitivity labels, publishing policies and auto-label policies/rules; configure simulation and enforcement."],
  ["purview_dlp", "dlp", "read", "Find DLP policies and inspect their rules, locations and enforcement settings."],
  ["purview_manage_dlp", "dlp", "write", "Create, modify or delete traditional, Endpoint or Copilot DLP policies and rules."],
  ["purview_classification", "classification", "read", "Find built-in and custom sensitive information types (SITs)."],
  ["purview_auth", "auth", "read", "Check authentication configuration; does not initiate sign-in or verify access."],
];

export function toolMode(value = process.env.PURVIEW_TOOL_MODE ?? "full") {
  if (!["full", "compact", "dispatcher"].includes(value)) throw new Error(`Invalid PURVIEW_TOOL_MODE: ${value}`);
  return value;
}

export function searchLimit(value = process.env.PURVIEW_TOOL_LIMIT ?? "8") {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("PURVIEW_TOOL_LIMIT must be an integer from 1 to 20.");
  return limit;
}

function groupFor(c) {
  return groups.find(([, d, a]) => d === c.domain && a === c.action)
    ?? [`purview_${c.action === "write" ? "manage_" : ""}${c.domain}`, c.domain, c.action, `${c.action === "read" ? "Inspect" : "Manage"} ${c.domain} capabilities.`];
}

export function routeFor(c, mode) {
  if (mode === "full") return { tool: c.id };
  if (mode === "dispatcher") return { tool: "purview_execute_capability", capability_id: c.id };
  return { tool: groupFor(c)[0], operation: c.id };
}

export function searchCapabilities(query, { policy = {}, filters = {}, limit = 8, mode = "dispatcher", entries = capabilities, rank = rankCapabilities, includeSchemas = false } = {}) {
  const allowed = filterCapabilities(entries, policy, filters);
  return rank(allowed, query).slice(0, Math.min(20, Math.max(1, limit))).map(({ capability: c, score }) => ({
    capability_id: c.id, description: c.description, domain: c.domain,
    action: c.action, operation: c.operation, risk: c.risk, destructive: c.destructive, score,
    ...(includeSchemas ? { input_schema: c.inputSchema } : {}), invocation: routeFor(c, mode),
  }));
}

export function createProjection({ mode = toolMode(), policy = {}, limit = searchLimit(), entries = capabilities, authorize, confirmDeletion } = {}) {
  toolMode(mode);
  searchLimit(limit);
  const registry = indexCapabilities(entries);
  const execute = (id, args, context) => executeCapability(id, args, policy, registry, authorize, { confirmDeletion, context });
  const visible = filterCapabilities(entries, policy);
  const calls = new Map();
  const tools = [];
  function register(tool, call) {
    if (calls.has(tool.name)) throw new Error(`Duplicate projected tool: ${tool.name}`);
    tools.push(tool); calls.set(tool.name, { tool, call });
  }

  if (mode === "full") {
    for (const c of visible) register(c.tool, (args, context) => execute(c.id, args, context));
  } else {
    const searchName = mode === "compact" ? "purview_search" : "purview_search_capabilities";
    register({
      name: searchName,
      description: "Find Purview operations by intent. Returns lightweight ranked candidates, not tenant data. Describe the selected capability to get its schema; include_schemas is optional.",
      annotations: READ,
      inputSchema: object({
        query: { type: "string", minLength: 1, maxLength: 2000 },
        domain: { type: "string", description: "Optional capability domain, e.g. labels or dlp." },
        action: { type: "string", enum: ["read", "write"] },
        destructive: { type: "boolean" },
        include_schemas: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: limit, default: limit },
      }, ["query"]),
    }, (args) => {
      const items = searchCapabilities(args.query, { policy, filters: args, limit: args.limit, mode, entries, includeSchemas: args.include_schemas });
      const result = { items, count: items.length };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    register({
      name: "purview_describe_capability",
      description: "Load one permitted capability's exact schema, constraints, examples and invocation mapping. Does not execute or authorize a particular tenant operation.",
      annotations: READ,
      inputSchema: object({ capability_id: { type: "string", minLength: 1, maxLength: 200 } }, ["capability_id"]),
    }, ({ capability_id }) => {
      const c = registry.get(capability_id);
      if (!c || !permitted(c, policy)) throw new CapabilityError("CAPABILITY_UNAVAILABLE", "Capability unavailable or not permitted.");
      const result = {
        capability_id: c.id, description: c.description, domain: c.domain, operation: c.operation,
        action: c.action, risk: c.risk, destructive: c.destructive, execution_kind: c.executionKind,
        input_schema: c.inputSchema, ...(c.outputSchema ? { output_schema: c.outputSchema } : {}),
        constraints: c.constraints, examples: c.examples, invocation: routeFor(c, mode),
        authorization: { permissions: c.permissions, scope_alternatives: c.scopeAlternatives,
          resource_policy_at_execution: Boolean(authorize), backend_permissions_still_required: true },
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    if (mode === "dispatcher") {
      register({
        name: "purview_execute_capability",
        description: "Execute a capability found with purview_search_capabilities. Supply its capability_id and schema-valid arguments; deletion requires user confirmation through form elicitation.",
        annotations: WRITE,
        inputSchema: object({ capability_id: { type: "string", minLength: 1 }, arguments: argumentObject }, ["capability_id"]),
      }, (args, context) => execute(args.capability_id, args.arguments ?? {}, context));
    } else {
      const projectedGroups = [...new Map(visible.map((c) => {
        const group = groupFor(c); return [`${c.domain}:${c.action}`, group];
      })).values()];
      projectedGroups.sort((a, b) => {
        const order = (g) => { const i = groups.findIndex(([name]) => name === g[0]); return i < 0 ? groups.length : i; };
        return order(a) - order(b) || a[0].localeCompare(b[0]);
      });
      for (const [name, domain, action, description] of projectedGroups) {
        const entries = visible.filter((c) => c.domain === domain && c.action === action);
        if (!entries.length) continue;
        const ids = new Set(entries.map((c) => c.id));
        register({ name, description: description + " Use purview_describe_capability for argument schemas.",
          annotations: action === "read" ? { ...READ, idempotentHint: entries.every((c) => c.idempotent), openWorldHint: entries.some((c) => c.openWorld) } : WRITE,
          inputSchema: object({ operation: { type: "string", enum: [...ids] }, arguments: argumentObject }, ["operation"]),
        }, (args, context) => {
          if (!ids.has(args.operation)) throw new Error("Operation is unavailable in this tool.");
          return execute(args.operation, args.arguments ?? {}, context);
        });
      }
    }
  }
  return {
    tools,
    async call(name, args = {}, context) {
      const entry = calls.get(name);
      if (!entry) throw new CapabilityError("CAPABILITY_UNAVAILABLE", `Unknown tool: ${name}`);
      const input = structuredClone(args);
      validateArguments(entry.tool.inputSchema, input, name);
      return entry.call(input, context);
    },
    instructions: mode === "full" ? "Use list filters and pagination, then fetch individual details. Deletion requires user confirmation through form elicitation; confirm:true alone does not authorize deletion."
      : `Use ${mode === "compact" ? "purview_search" : "purview_search_capabilities"} to find candidate operations, then purview_describe_capability for the selected input_schema, constraints and examples. Search include_schemas:true is an optional shortcut. Follow the returned invocation mapping. Capability names mentioned in prompts are internal operation IDs. Keep filters unchanged when following next_cursor; pass cursor and limit inside arguments. Only execute writes the user requested; deletion requires user confirmation through form elicitation. Discovery is not authorization; execution rechecks policy. Do not automatically retry errors, especially writes with uncertain outcomes.`,
  };
}
