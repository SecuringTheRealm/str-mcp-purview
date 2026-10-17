import { test } from "node:test";
import assert from "node:assert/strict";
import { defineCapability, indexCapabilities, validateRegistry } from "../src/capabilities/contract.js";
import { createProjection } from "../src/mcp/projection.js";
import { executeCapability } from "../src/dispatch/execute.js";
import { errorResult } from "../src/dispatch/errors.js";
import { syntheticCatalogue } from "../benchmarks/synthetic-catalogue.js";
import { simulateAgent } from "../benchmarks/simulate-agent.js";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";

test("160-entry scripted agent simulation completes in compact and dispatcher", async () => {
  for (const mode of ["compact", "dispatcher"]) {
    const report = await simulateAgent(mode);
    assert.equal(report.catalogue_size, 160);
    assert.equal(report.all_passed, true, JSON.stringify(report));
  }
});

test("new operation/domain requires no server or routing edits; metadata governs risk", async () => {
  const fixture = syntheticCatalogue(1);
  const publish = fixture.entries.find((c) => c.operation === "publish" && c.domain === "records");
  assert.equal(publish.action, "write");
  assert.equal(publish.destructive, true);
  const p = createProjection({ mode: "compact", entries: fixture.entries });
  assert.ok(p.tools.some((t) => t.name === "purview_manage_records"));
  const description = (await p.call("purview_describe_capability", { capability_id: publish.aliases[0] })).structuredContent;
  assert.equal(description.capability_id, publish.id);
  assert.equal(description.operation, "publish");
  assert.equal(description.risk, "destructive");
  assert.equal(description.invocation.tool, "purview_manage_records");
  assert.equal(p.tools.length, createProjection({ mode: "compact", entries: syntheticCatalogue().entries }).tools.length);
});

test("contract rejects incoherent risk, invalid schemas/examples, collisions and unsupported jobs", () => {
  const c = syntheticCatalogue(1).entries[0];
  assert.throws(() => defineCapability({ ...c, action: "write" }), /safety/);
  assert.throws(() => defineCapability({ ...c, executionKind: "job" }), /Unsupported/);
  assert.throws(() => defineCapability({ ...c, inputSchema: { type: "object" } }), /closed/);
  assert.throws(() => defineCapability({ ...c, examples: [{ arguments: { unexpected: true } }] }), /example/);
  assert.throws(() => defineCapability({ ...c, examples: [] }), /example/);
  assert.throws(() => validateRegistry([c, { ...c, id: "other", aliases: [c.id] }]), /Duplicate/);
  assert.throws(() => defineCapability({ ...c, scopeAlternatives: [[]] }), /metadata/);
});

test("generated compact tool collisions fail instead of shadowing discovery", () => {
  const c = syntheticCatalogue(1).entries[0];
  const collision = defineCapability({ ...c, domain: "search" });
  assert.throws(() => createProjection({ mode: "compact", entries: [collision] }), /Duplicate projected tool/);
});

test("argument policy is enforced in all modes, after validation and before handlers", async () => {
  for (const mode of ["full", "compact", "dispatcher"]) {
    const fixture = syntheticCatalogue(1);
    let checked = 0;
    const p = createProjection({ mode, entries: fixture.entries, authorize: ({ arguments: args }) => { checked++; args.identity = "tampered"; return false; } });
    const id = "sim_finance_markings_publish";
    const tool = mode === "full" ? id : mode === "compact" ? "purview_manage_labels" : "purview_execute_capability";
    const args = (input) => mode === "full" ? input : { [mode === "compact" ? "operation" : "capability_id"]: id, arguments: input };
    await assert.rejects(p.call(tool, args({ identity: "production" })), { code: "VALIDATION_ERROR" });
    assert.equal(checked, 0);
    await assert.rejects(p.call(tool, args({ identity: "production", confirm: true })), { code: "POLICY_DENIED" });
    assert.equal(checked, 1);
    assert.equal(fixture.calls.length, 0);
  }
});

test("authorization hook fails closed and cannot mutate executed arguments", async () => {
  const fixture = syntheticCatalogue(1);
  const registry = indexCapabilities(fixture.entries);
  const id = "sim_finance_markings_get";
  for (const authorize of [() => undefined, () => "true", () => { throw Error("private policy detail"); }]) {
    await assert.rejects(executeCapability(id, { identity: "sandbox" }, {}, registry, authorize), { code: "POLICY_DENIED" });
  }
  assert.equal(fixture.calls.length, 0);
  await executeCapability(id, { identity: "sandbox" }, {}, registry, ({ arguments: args }) => { args.identity = "production"; return true; });
  assert.equal(fixture.calls[0].arguments.identity, "sandbox");
});

test("describe and execution enforce permissions, scopes, flags and aliases equally", async () => {
  const fixture = syntheticCatalogue(1);
  const id = "sim_legal_schedules_export";
  for (const policy of [
    { permissions: [], scopes: ["Simulation.Export"], features: ["sim_exports"] },
    { permissions: ["export_data"], scopes: [], features: ["sim_exports"] },
    { permissions: ["export_data"], scopes: ["Simulation.Export"], features: [] },
  ]) {
    const p = createProjection({ mode: "dispatcher", entries: fixture.entries, policy });
    for (const capability_id of [id, "legal_schedules_export"]) {
      await assert.rejects(p.call("purview_describe_capability", { capability_id }), { code: "CAPABILITY_UNAVAILABLE" });
      await assert.rejects(p.call("purview_execute_capability", { capability_id, arguments: { identity: "sandbox" } }), { code: "CAPABILITY_UNAVAILABLE" });
    }
  }
  assert.equal(fixture.calls.length, 0);
});

test("structured errors distinguish schema, policy and backend failures without automatic retries", async () => {
  const c = syntheticCatalogue(1).entries[0];
  const bad = defineCapability({ ...c, handler: async () => { throw Error("Backend unavailable"); } });
  let failure;
  try { await executeCapability(bad.id, { identity: "sandbox" }, {}, indexCapabilities([bad])); } catch (e) { failure = e; }
  const result = errorResult(failure);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "BACKEND_ERROR");
  assert.equal(result.structuredContent.error.retryable, false);
});

test("server intersects caller policy without losing enabled features, and resources use the execution gate", async () => {
  const settings = { PURVIEW_FEATURES: "sim_exports", PURVIEW_PERMISSIONS: "export_data", PURVIEW_SCOPES: "Simulation.Export",
    PURVIEW_ALLOWED_CAPABILITIES: undefined, PURVIEW_ALLOWED_DOMAINS: undefined, PURVIEW_READ_ONLY: "false", PURVIEW_ALLOW_DESTRUCTIVE: "true", MCP_REQUEST_LOGGING: "false" };
  const saved = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  const setEnv = (values) => { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  setEnv(settings);
  const fixture = syntheticCatalogue(1);
  const exported = fixture.entries.find((c) => c.operation === "export");
  const resource = defineCapability({ ...fixture.entries.find((c) => c.operation === "list"), id: "list_sensitivity_labels", aliases: [] });
  const connect = async (context, fn) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({ toolMode: "dispatcher", capabilities: [exported, resource], ...context });
    const client = new Client({ name: "policy-contract-test", version: "1" });
    try { await server.connect(serverTransport); await client.connect(clientTransport); await fn(client); }
    finally { await client.close(); await server.close(); }
  };
  try {
    for (const capabilityPolicy of [undefined, { allowedIds: [exported.id] }]) {
      await connect({ capabilityPolicy }, async (client) => {
        const described = await client.callTool({ name: "purview_describe_capability", arguments: { capability_id: exported.id } });
        assert.equal(described.isError, undefined);
        assert.equal(described.structuredContent.capability_id, exported.id);
      });
    }
    await connect({ capabilityPolicy: { features: [] } }, async (client) => {
      const denied = await client.callTool({ name: "purview_describe_capability", arguments: { capability_id: exported.id } });
      assert.equal(denied.structuredContent.error.code, "CAPABILITY_UNAVAILABLE");
    });
    process.env.PURVIEW_FEATURES = "";
    await connect({ capabilityPolicy: { features: ["sim_exports"] } }, async (client) => {
      const denied = await client.callTool({ name: "purview_describe_capability", arguments: { capability_id: exported.id } });
      assert.equal(denied.structuredContent.error.code, "CAPABILITY_UNAVAILABLE");
    });
    const before = fixture.calls.length;
    await connect({ authorizeCapability: () => false }, async (client) => {
      assert.equal((await client.listResources()).resources.length, 1);
      await assert.rejects(client.readResource({ uri: "purview://label-catalog" }));
    });
    assert.equal(fixture.calls.length, before);
  } finally { setEnv(saved); }
});
