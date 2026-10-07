import { test, mock } from "node:test";
import assert from "node:assert/strict";

const backendCalls = [];
mock.module("../src/powershell.js", { namedExports: { powershell: { invoke: async (cmdlet, params) => {
  backendCalls.push({ cmdlet, params });
  return { Name: "Finance protection", Guid: "11111111-1111-1111-1111-111111111111", Mode: "Enable" };
} } } });
const { createDeletionConfirmation } = await import("../src/mcp/deletion-confirmation.js");
const { capabilities } = await import("../src/capabilities/registry.js");
const { createProjection, routeFor } = await import("../src/mcp/projection.js");
const { executeCapability } = await import("../src/dispatch/execute.js");
const { createServer } = await import("../src/server.js");
const { createMcpHandler, InMemoryTransport } = await import("@modelcontextprotocol/server");
const { Client } = await import("@modelcontextprotocol/client");

const accepted = { action: "accept", content: { confirm: true } };
function context(state, response = accepted, elicitation = { form: {} }) {
  return { clientCapabilities: { elicitation }, mcpReq: {
    envelope: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
    requestState: () => state, inputResponses: state ? { confirm_deletion: response } : undefined,
  } };
}
function fixture(options = {}) {
  let changed = false, clock = 0;
  const mutations = [];
  const entries = capabilities.map((c) => ({ ...c, handler: async (args) => {
    mutations.push({ id: c.id, args }); return { content: [{ type: "text", text: "Deleted" }] };
  } }));
  const store = new Map();
  const settings = { principal: "alice", client: "client-one", tenant: "tenant-one", store, now: () => clock,
    resolve: async () => ({ identity: "stable-guid", name: "Finance", consequence: "Removes protection.", fingerprint: changed ? "v2" : "v1" }), ...options };
  return { entries, mutations, store, settings, guard: createDeletionConfirmation(settings),
    change: () => { changed = true; }, expire: () => { clock = 300001; } };
}

test("every deletion in every projection requires elicitation, then executes the reviewed GUID once", async () => {
  for (const mode of ["full", "compact", "dispatcher"]) for (const capability of capabilities.filter((c) => c.operation === "delete")) {
    const f = fixture();
    const p = createProjection({ mode, entries: f.entries, confirmDeletion: f.guard });
    const { tool, ...route } = routeFor(capability, mode);
    const deletionArgs = { identity: "Finance", ...(capability.inputSchema.properties.confirm ? { confirm: true } : {}) };
    const args = mode === "full" ? deletionArgs : { ...route, arguments: deletionArgs };
    const initial = await p.call(tool, args, context());
    assert.equal(initial.resultType, "input_required");
    assert.match(initial.inputRequests.confirm_deletion.params.message, /Finance.*stable-guid.*tenant-one/);
    assert.equal(initial.inputRequests.confirm_deletion.params.requestedSchema.properties.confirm.default, false);
    assert.equal(f.mutations.length, 0);
    await p.call(tool, args, context(initial.requestState));
    assert.deepEqual(f.mutations, [{ id: capability.id, args: { ...deletionArgs, identity: "stable-guid" } }]);
    await assert.rejects(p.call(tool, args, context(initial.requestState)), /consumed/);
  }
});

test("decline, cancellation and a non-affirmative or malformed answer never delete", async () => {
  for (const response of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirm: false } }, { action: "accept", content: { confirm: "true" } }, { action: "accept" }, {}]) {
    const f = fixture(), c = capabilities.find((c) => c.id === "remove_dlp_rule"), args = { identity: "Finance" };
    const first = await f.guard(c, args, context());
    const result = await f.guard(c, args, context(first.result.requestState, response));
    assert.match(result.result.content[0].text, /Nothing was deleted/);
    assert.equal(f.store.size, 0);
  }
});

test("forged, cross-user, cross-tenant, changed-argument, expired and stale reviews are denied", async () => {
  const c = capabilities.find((c) => c.id === "remove_dlp_rule"), args = { identity: "Finance" };
  for (const kind of ["forged", "user", "client", "tenant", "arguments", "expired", "changed"]) {
    const f = fixture();
    const first = await f.guard(c, args, context());
    const state = first.result.requestState;
    let guard = f.guard, retryArgs = args, retryState = state;
    if (kind === "forged") retryState += "x";
    if (kind === "user") guard = createDeletionConfirmation({ ...f.settings, principal: "bob" });
    if (kind === "client") guard = createDeletionConfirmation({ ...f.settings, client: "client-two" });
    if (kind === "tenant") guard = createDeletionConfirmation({ ...f.settings, tenant: "tenant-two" });
    if (kind === "arguments") retryArgs = { identity: "Another policy" };
    if (kind === "expired") f.expire();
    if (kind === "changed") f.change();
    await assert.rejects(guard(c, retryArgs, context(retryState)), { code: "CONFIRMATION_REQUIRED" }, kind);
  }
});

test("unsolicited approval cannot bypass the initial review; missing responses repeat it", async () => {
  const f = fixture(), c = capabilities.find((c) => c.id === "remove_dlp_rule"), args = { identity: "Finance" };
  const ctx = context(); ctx.mcpReq.inputResponses = { confirm_deletion: accepted };
  const first = await f.guard(c, args, ctx);
  const empty = context(first.result.requestState); empty.mcpReq.inputResponses = {};
  assert.equal((await f.guard(c, args, empty)).result.requestState, first.result.requestState);
});

test("unsupported clients, unbound remote callers and direct deletion calls fail closed", async () => {
  const f = fixture(), c = capabilities.find((c) => c.id === "remove_dlp_rule"), args = { identity: "Finance", confirm: true };
  for (const elicitation of [undefined, { url: {} }]) {
    const ctx = context(); ctx.clientCapabilities.elicitation = elicitation;
    await assert.rejects(f.guard(c, args, ctx), /form elicitation support/);
  }
  await assert.rejects(createDeletionConfirmation({ tenant: "tenant-one" })(c, args, context()), /trusted caller/);
  await assert.rejects(executeCapability(c.id, args), /confirm:true alone is insufficient/);
  assert.equal(f.mutations.length, 0);
});

test("concurrent retries claim a review once; authorization is checked again on the resolved identity", async () => {
  const f = fixture(), args = { identity: "Finance" };
  let allow = true;
  const p = createProjection({ mode: "full", entries: f.entries, confirmDeletion: f.guard,
    authorize: ({ arguments: input }) => input.identity !== "stable-guid" || allow });
  const first = await p.call("remove_dlp_rule", args, context());
  const results = await Promise.allSettled([p.call("remove_dlp_rule", args, context(first.requestState)), p.call("remove_dlp_rule", args, context(first.requestState))]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.mutations.length, 1);
  const next = await p.call("remove_dlp_rule", args, context()); allow = false;
  await assert.rejects(p.call("remove_dlp_rule", args, context(next.requestState)), { code: "POLICY_DENIED" });
  assert.equal(f.mutations.length, 1);
});

test("modern HTTP wire carries input_required and resumes across fresh server instances", async () => {
  const saved = process.env.AZURE_TENANT_ID; process.env.AZURE_TENANT_ID = "test-tenant";
  const handler = createMcpHandler((ctx) => createServer({ ...ctx, transport: "http", confirmationPrincipal: "verified-alice", confirmationClientId: "verified-client" }), { responseMode: "json" });
  const rpc = async (id, name, extra = {}) => {
    const response = await handler.fetch(new Request("http://localhost/mcp", { method: "POST", headers: {
      "content-type": "application/json", accept: "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": name,
    }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: {
      name, arguments: { identity: "Finance protection" }, ...extra,
      _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } } },
    } }) }));
    return response.json();
  };
  try {
    let id = 0;
    for (const [name, cmdlet] of [["remove_dlp_rule", "Remove-DlpComplianceRule"], ["remove_dlp_policy", "Remove-DlpCompliancePolicy"], ["remove_sensitivity_label", "Remove-Label"], ["remove_label_policy", "Remove-LabelPolicy"]]) {
      const before = backendCalls.filter((c) => c.cmdlet.startsWith("Remove-")).length;
      const first = await rpc(++id, name);
      assert.equal(first.result.resultType, "input_required");
      assert.equal(backendCalls.filter((c) => c.cmdlet.startsWith("Remove-")).length, before);
      const second = await rpc(++id, name, { requestState: first.result.requestState, inputResponses: { confirm_deletion: accepted } });
      assert.equal(second.result.isError, undefined);
      assert.deepEqual(backendCalls.at(-1), { cmdlet, params: { Identity: "11111111-1111-1111-1111-111111111111", Confirm: false } });
      const replay = await rpc(++id, name, { requestState: first.result.requestState, inputResponses: { confirm_deletion: accepted } });
      assert.equal(replay.result.structuredContent.error.code, "CONFIRMATION_REQUIRED");
      assert.equal(backendCalls.filter((c) => c.cmdlet.startsWith("Remove-")).length, before + 1);
    }
  } finally { await handler.close(); if (saved === undefined) delete process.env.AZURE_TENANT_ID; else process.env.AZURE_TENANT_ID = saved; }
});

test("legacy stdio-style SDK interaction also elicits instead of trusting confirm:true", async () => {
  const saved = process.env.AZURE_TENANT_ID; process.env.AZURE_TENANT_ID = "test-tenant";
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer({ transport: "stdio" });
  const client = new Client({ name: "test", version: "1" }, { capabilities: { elicitation: { form: {} } } });
  let prompts = 0;
  client.setRequestHandler("elicitation/create", async () => { prompts++; return accepted; });
  try {
    await server.connect(st); await client.connect(ct);
    const result = await client.callTool({ name: "remove_sensitivity_label", arguments: { identity: "Finance protection", confirm: true } });
    assert.equal(result.isError, undefined); assert.equal(prompts, 1);
    assert.equal(backendCalls.at(-1).params.Identity, "11111111-1111-1111-1111-111111111111");
  } finally { await client.close(); await server.close(); if (saved === undefined) delete process.env.AZURE_TENANT_ID; else process.env.AZURE_TENANT_ID = saved; }
});
