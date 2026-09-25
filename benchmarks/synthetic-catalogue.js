// Test-only catalogue: these are invented operations, not supported Purview APIs.
import { defineCapability } from "../src/capabilities/contract.js";
import { capabilityResult } from "../src/capabilities/results.js";
import { createListPaginator } from "../src/pagination.js";

const families = {
  labels: ["finance markings", "legal markings", "research markings", "supplier markings", "healthcare markings"],
  dlp: ["endpoint guardrails", "exchange guardrails", "sharepoint guardrails", "copilot guardrails", "teams guardrails"],
  classification: ["medical detectors", "financial detectors", "address detectors", "identity detectors", "credential detectors"],
  records: ["legal schedules", "finance schedules", "research schedules", "supplier schedules", "healthcare schedules"],
};
export const operations = ["get", "list", "create", "update", "delete", "validate", "publish", "export"];
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

export function syntheticCatalogue(perDomain = 5) {
  const calls = [];
  const state = new Map();
  const paginate = createListPaginator();
  const entries = [];
  for (const [domain, names] of Object.entries(families)) {
    for (const noun of names.slice(0, perDomain)) {
      const key = noun.replaceAll(" ", "_");
      state.set(key, new Map());
      for (const operation of operations) {
        const id = `sim_${key}_${operation}`;
        const action = ["get", "list", "validate", "export"].includes(operation) ? "read" : "write";
        const destructive = ["delete", "publish"].includes(operation);
        const properties = operation === "list" ? {
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          cursor: { type: "string", maxLength: 2048 },
        } : { identity: { type: "string", minLength: 1, maxLength: 100 } };
        const required = operation === "list" ? [] : ["identity"];
        if (destructive) { properties.confirm = { const: true, type: "boolean" }; required.push("confirm"); }
        if (operation === "update") properties.note = { type: "string", maxLength: 200 };
        entries.push(defineCapability({
          id, domain, operation, action, destructive,
          risk: destructive ? "destructive" : action === "read" ? "read-only" : "non-destructive",
          idempotent: action === "read", openWorld: false,
          description: `${operation} ${noun} in the simulated catalogue.`,
          keywords: [noun, domain, operation], aliases: [`${key}_${operation}`],
          permissions: operation === "export" ? ["export_data"] : [],
          scopeAlternatives: operation === "export" ? [["Simulation.Export"]] : [],
          features: operation === "export" ? ["sim_exports"] : [],
          constraints: ["Synthetic data only; never calls Graph or PowerShell.", ...(destructive ? ["Explicit confirmation is required."] : [])],
          examples: [{ arguments: operation === "list" ? { limit: 25 } : { identity: "sandbox-alpha", ...(destructive ? { confirm: true } : {}) } }],
          inputSchema: object(properties, required),
          handler: async (args) => {
            calls.push({ id, arguments: structuredClone(args) });
            const records = state.get(key);
            if (operation === "list") {
              const rows = Array.from({ length: 63 }, (_, i) => ({ id: `sample-${String(i).padStart(3, "0")}`, name: `Sample ${i}` }));
              return paginate(id, args, rows, (items) => `${items.length} synthetic records`);
            }
            if (operation === "create") records.set(args.identity, { identity: args.identity, status: "draft" });
            if (operation === "publish") records.set(args.identity, { identity: args.identity, status: "published" });
            if (operation === "update") records.set(args.identity, { ...records.get(args.identity), identity: args.identity, note: args.note });
            if (operation === "delete") records.delete(args.identity);
            return capabilityResult({ capability_id: id, operation, record: records.get(args.identity) ?? null,
              ...(operation === "validate" ? { valid: records.has(args.identity) } : {}) }, `Simulated ${operation} completed.`);
          },
        }));
      }
    }
  }
  return { entries, calls, state };
}

export const simulationScenarios = [
  { query: "Create finance markings", domain: "labels", expected: "sim_finance_markings_create", args: { identity: "sandbox-alpha" } },
  { query: "Verify finance markings", domain: "labels", expected: "sim_finance_markings_validate", args: { identity: "sandbox-alpha" } },
  { query: "Publish finance markings", domain: "labels", expected: "sim_finance_markings_publish", args: { identity: "sandbox-alpha", confirm: true } },
  { query: "Inspect finance markings", domain: "labels", expected: "sim_finance_markings_get", args: { identity: "sandbox-alpha" } },
  { query: "Modify endpoint guardrails", domain: "dlp", expected: "sim_endpoint_guardrails_update", args: { identity: "sandbox-alpha", note: "Reviewed" } },
  { query: "Find medical detectors", domain: "classification", expected: "sim_medical_detectors_list", args: { limit: 25 } },
  { query: "Download legal schedules", domain: "records", expected: "sim_legal_schedules_export", args: { identity: "sandbox-alpha" } },
  { query: "Delete finance markings", domain: "labels", expected: "sim_finance_markings_delete", args: { identity: "sandbox-alpha", confirm: true } },
];
