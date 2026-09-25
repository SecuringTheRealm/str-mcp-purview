import Ajv from "ajv";

const ajv = new Ajv({ strict: false });
const identifier = /^[a-z][a-z0-9_]*$/;

/** Explicit extension contract. Operation names never determine safety. */
export function defineCapability(entry) {
  const c = {
    aliases: [], permissions: [], scopeAlternatives: [], features: [],
    constraints: [], examples: [], executionKind: "immediate", ...entry,
  };
  c.tool = {
    name: c.id, description: c.description, inputSchema: c.inputSchema,
    ...(c.outputSchema ? { outputSchema: c.outputSchema } : {}),
    annotations: {
      readOnlyHint: c.action === "read", destructiveHint: c.destructive,
      idempotentHint: c.idempotent, openWorldHint: c.openWorld,
    },
  };
  c.annotations = c.tool.annotations;
  validateRegistry([c]);
  return c;
}

export function validateRegistry(entries) {
  const identifiers = new Set();
  for (const c of entries) {
    for (const key of ["id", "domain", "operation", "risk", "description", "inputSchema"]) {
      if (!c[key]) throw new Error(`Capability missing ${key}: ${c.id}`);
    }
    if (!identifier.test(c.domain) || !identifier.test(c.operation)) throw new Error(`Invalid domain/operation: ${c.id}`);
    if (!["read", "write"].includes(c.action) || typeof c.destructive !== "boolean"
      || typeof c.idempotent !== "boolean" || typeof c.openWorld !== "boolean"
      || !["read-only", "non-destructive", "destructive"].includes(c.risk)
      || c.risk !== (c.destructive ? "destructive" : c.action === "read" ? "read-only" : "non-destructive")
      || (c.action === "read" && c.destructive)) throw new Error(`Invalid capability safety metadata: ${c.id}`);
    if (c.executionKind !== "immediate") throw new Error(`Unsupported execution kind: ${c.id}`);
    if (typeof c.handler !== "function") throw new Error(`Invalid capability handler: ${c.id}`);
    for (const key of ["keywords", "aliases", "permissions", "features", "constraints"]) {
      if (!Array.isArray(c[key]) || c[key].some((s) => typeof s !== "string" || !s.trim())) throw new Error(`Invalid ${key}: ${c.id}`);
    }
    if (!c.keywords.length || !Array.isArray(c.scopeAlternatives)
      || c.scopeAlternatives.some((set) => !Array.isArray(set) || !set.length || set.some((s) => typeof s !== "string" || !s))) throw new Error(`Invalid capability metadata: ${c.id}`);
    for (const id of [c.id, ...c.aliases]) {
      if (!identifier.test(id) || identifiers.has(id)) throw new Error(`Duplicate or invalid capability ID/alias: ${id}`);
      identifiers.add(id);
    }
    if (c.inputSchema.type !== "object" || c.inputSchema.additionalProperties !== false) throw new Error(`Capability requires a closed object schema: ${c.id}`);
    const validate = ajv.compile(c.inputSchema);
    if (c.outputSchema) ajv.compile(c.outputSchema);
    if (!Array.isArray(c.examples) || !c.examples.length || c.examples.some((example) => !example || !validate(example.arguments))) throw new Error(`Invalid capability example: ${c.id}`);
  }
  return entries;
}

export function indexCapabilities(entries) {
  validateRegistry(entries);
  return new Map(entries.flatMap((c) => [c.id, ...c.aliases].map((id) => [id, c])));
}
