import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createProjection } from "../src/mcp/projection.js";
import { syntheticCatalogue, simulationScenarios } from "./synthetic-catalogue.js";
import { validateArguments } from "../src/dispatch/execute.js";
import { createDeletionConfirmation } from "../src/mcp/deletion-confirmation.js";

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const policy = { permissions: ["export_data"], scopes: ["Simulation.Export"], features: ["sim_exports"] };

export async function simulateAgent(mode = "dispatcher") {
  const fixture = syntheticCatalogue();
  const authorize = ({ arguments: args }) => args.identity !== "production";
  const confirmDeletion = createDeletionConfirmation({ principal: "scripted-user", client: "scripted-client", tenant: "synthetic-tenant", store: new Map(),
    resolve: async (capability, args) => ({ identity: args.identity, name: args.identity, consequence: "Deletes a synthetic record.",
      fingerprint: JSON.stringify(fixture.state.get(capability.id.slice(4, -capability.operation.length - 1))?.get(args.identity)) }),
  });
  const projection = createProjection({ mode, entries: fixture.entries, policy, authorize, confirmDeletion });
  const interaction = (state) => ({ clientCapabilities: { elicitation: { form: {} } }, mcpReq: {
    envelope: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }, requestState: () => state,
    inputResponses: state ? { confirm_deletion: { action: "accept", content: { confirm: true } } } : undefined,
  } });
  const searchName = mode === "compact" ? "purview_search" : "purview_search_capabilities";
  const transcript = [];
  // The scripted client selects top-1. Expected IDs are ONLY used afterwards to
  // evaluate the choice; they are never passed to search or used to select it.
  for (const scenario of simulationScenarios) {
    const start = performance.now();
    const args = { query: scenario.query, domain: scenario.domain };
    const search = await projection.call(searchName, args);
    const items = search.structuredContent.items;
    const selected = items[0];
    if (!selected) { transcript.push({ query: scenario.query, pass: false, reason: "No candidates" }); continue; }
    const described = await projection.call("purview_describe_capability", { capability_id: selected.capability_id });
    const detail = described.structuredContent;
    validateArguments(detail.input_schema, structuredClone(scenario.args), selected.capability_id);
    const { tool, ...route } = detail.invocation;
    let result = await projection.call(tool, { ...route, arguments: scenario.args }, interaction());
    const elicitationRounds = result.resultType === "input_required" ? 1 : 0;
    if (elicitationRounds) result = await projection.call(tool, { ...route, arguments: scenario.args }, interaction(result.requestState));
    const eager = await projection.call(searchName, { ...args, include_schemas: true });
    transcript.push({ query: scenario.query, expected: scenario.expected, selected: selected.capability_id,
      pass: selected.capability_id === scenario.expected && !result.isError,
      candidates: items.map((c) => ({ id: c.capability_id, score: c.score })),
      schemas_in_search: items.filter((c) => c.input_schema).length, schemas_described: 1,
      search_bytes: bytes(search), describe_bytes: bytes(described), eager_search_bytes: bytes(eager),
      latency_ms: +(performance.now() - start).toFixed(3),
      invocation: { tool, ...route, arguments: scenario.args }, elicitation_rounds: elicitationRounds, result: result.structuredContent });
  }

  const checks = [];
  const expectDenied = async (name, p, tool, args, code = "CAPABILITY_UNAVAILABLE") => {
    const before = fixture.calls.length;
    try { await p.call(tool, args); checks.push({ name, pass: false, reason: "Unexpected success" }); }
    catch (error) { checks.push({ name, pass: fixture.calls.length === before && error.code === code, code: error.code ?? "ERROR" }); }
  };
  const restricted = createProjection({ mode, entries: fixture.entries, policy: { readOnly: true }, authorize });
  await expectDenied("describe hidden write", restricted, "purview_describe_capability", { capability_id: "sim_finance_markings_publish" });
  await expectDenied("describe hidden alias", restricted, "purview_describe_capability", { capability_id: "finance_markings_publish" });
  await expectDenied("describe unknown ID", restricted, "purview_describe_capability", { capability_id: "unknown" });
  const invoke = mode === "compact" ? "purview_manage_labels" : "purview_execute_capability";
  const route = (id, args) => ({ [mode === "compact" ? "operation" : "capability_id"]: id, arguments: args });
  await expectDenied("direct hidden write", restricted, invoke, route("sim_finance_markings_publish", { identity: "sandbox-alpha", confirm: true }));
  await expectDenied("production resource denied", projection, invoke, route("sim_finance_markings_publish", { identity: "production", confirm: true }), "POLICY_DENIED");
  await expectDenied("missing confirmation", projection, invoke, route("sim_finance_markings_publish", { identity: "sandbox-alpha" }), "VALIDATION_ERROR");
  await expectDenied("unexpected argument", projection, invoke, route("sim_finance_markings_create", { identity: "sandbox-alpha", arbitrary_command: "unsafe" }), "VALIDATION_ERROR");
  const hidden = await restricted.call(searchName, { query: "publish export", include_schemas: true });
  checks.push({ name: "restricted search has no write/export leakage", pass: hidden.structuredContent.items.every((c) => c.action === "read" && c.operation !== "export") });
  const none = await projection.call(searchName, { query: "zzzxxyyqqq" });
  checks.push({ name: "no match causes abstention", pass: none.structuredContent.count === 0 });

  const listId = "sim_medical_detectors_list";
  const detail = (await projection.call("purview_describe_capability", { capability_id: listId })).structuredContent;
  const { tool, ...listRoute } = detail.invocation;
  const pages = [];
  let cursor;
  do {
    const page = (await projection.call(tool, { ...listRoute, arguments: { limit: 25, ...(cursor ? { cursor } : {}) } })).structuredContent;
    pages.push(page); cursor = page.next_cursor;
  } while (cursor && pages.length < 5);
  checks.push({ name: "pagination 25/25/13 without duplicates", pass: JSON.stringify(pages.map((p) => p.count)) === "[25,25,13]" && new Set(pages.flatMap((p) => p.items.map((r) => r.id))).size === 63 });
  const small = createProjection({ mode, entries: syntheticCatalogue(1).entries, policy });
  checks.push({ name: "tool count unchanged from 32 to 160 capabilities", pass: small.tools.length === projection.tools.length });
  checks.push({ name: "lifecycle read observes published state", pass: transcript[3].result?.record?.status === "published" });
  checks.push({ name: "delete removes synthetic record", pass: fixture.state.get("finance_markings").size === 0 });
  return { mode, simulation: "Scripted top-1 client; synthetic data; no LLM or tenant calls", catalogue_size: fixture.entries.length,
    tool_count: projection.tools.length, tool_schema_bytes: bytes(projection.tools),
    all_passed: transcript.every((s) => s.pass && s.schemas_in_search === 0) && checks.every((c) => c.pass), transcript, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const reports = await Promise.all([simulateAgent("compact"), simulateAgent("dispatcher")]);
  console.log(JSON.stringify(reports, null, 2));
  if (reports.some((r) => !r.all_passed)) process.exitCode = 1;
}
