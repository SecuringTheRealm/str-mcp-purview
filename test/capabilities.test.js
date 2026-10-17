import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = [];
mock.module("../src/powershell.js", { namedExports: { powershell: { invoke: async (cmdlet, params) => {
  calls.push({ cmdlet, params });
  if (cmdlet === "Get-DlpCompliancePolicy") return Array.from({ length: 30 }, (_, i) => ({ Name: `Policy ${String(i).padStart(2, "0")}`, Guid: String(i), Workload: "SharePoint" }));
  return { Name: "example", Guid: "id", DisplayName: "Example" };
} } } });
mock.module("../src/graph.js", { namedExports: { appOnly: false, graphGet: async (path) => {
  calls.push({ path }); return { value: [{ id: "settings", isMandatory: true }] };
} } });

const { capabilities } = await import("../src/capabilities/registry.js");
const { validateRegistry } = await import("../src/capabilities/contract.js");
const { createProjection, searchCapabilities, toolMode } = await import("../src/mcp/projection.js");
const { executeCapability } = await import("../src/dispatch/execute.js");
const { filterCapabilities, policyFromEnvironment } = await import("../src/retrieval/filters.js");
const { authStatus } = await import("../src/capabilities/auth.js");

test("registry rejects missing metadata, unresolved handlers and colliding aliases", () => {
  assert.equal(validateRegistry(capabilities), capabilities);
  const c = capabilities[0];
  assert.throws(() => validateRegistry([c, { ...c, id: "other", aliases: [c.id] }]), /Duplicate/);
  assert.throws(() => validateRegistry([{ ...c, handler: undefined }]), /handler/);
  assert.throws(() => validateRegistry([{ ...c, domain: "" }]), /domain/);
});

test("domain, action and destructive filters run before ranking", () => {
  let seen;
  searchCapabilities("delete", {
    filters: { domain: "dlp", action: "read", destructive: false },
    rank(entries) { seen = entries; return []; },
  });
  assert.ok(seen.length > 0);
  assert.ok(seen.every((c) => c.domain === "dlp" && c.action === "read" && !c.destructive));
  assert.deepEqual(searchCapabilities("delete", { policy: { allowedIds: [] } }), []);
  assert.ok(filterCapabilities(capabilities, { allowDestructive: false }).every((c) => !c.destructive));
  const graph = capabilities.find((c) => c.id === "get_label_policy_settings");
  assert.equal(filterCapabilities([graph], { scopes: [] }).length, 0);
  assert.equal(filterCapabilities([graph], { scopes: ["InformationProtectionPolicy.Read"] }).length, 1);
  const restricted = { ...graph, permissions: ["review"], features: ["preview"] };
  assert.equal(filterCapabilities([restricted], { permissions: [], features: ["preview"] }).length, 0);
  assert.equal(filterCapabilities([restricted], { permissions: ["review"], features: [] }).length, 0);
});

test("mode projections carry conservative annotations and honour read-only policy", () => {
  assert.equal(createProjection({ mode: "compact" }).tools.find((t) => t.name === "purview_manage_dlp").annotations.destructiveHint, true);
  assert.equal(createProjection({ mode: "compact", policy: { readOnly: true } }).tools.some((t) => t.name.includes("manage")), false);
  assert.throws(() => toolMode("typo"), /PURVIEW_TOOL_MODE must be/);
  assert.equal(toolMode(" Compact "), "compact");
});

test("all projections preserve PowerShell parameters, Graph reads and pagination", async () => {
  for (const mode of ["full", "compact", "dispatcher"]) {
    const projection = createProjection({ mode });
    const call = (id, args, compactTool) => mode === "full" ? projection.call(id, args)
      : mode === "compact" ? projection.call(compactTool, { operation: id, arguments: args })
        : projection.call("purview_execute_capability", { capability_id: id, arguments: args });
    await call("set_dlp_rule", { identity: "r", report_severity_level: "High", sensitive_information_types: ["Credit Card Number"] }, "purview_manage_dlp");
    assert.deepEqual(calls.at(-1), { cmdlet: "Set-DlpComplianceRule", params: { Identity: "r", ContentContainsSensitiveInformation: [{ Name: "Credit Card Number" }], ReportSeverityLevel: "High", Confirm: false } });
    await call("create_copilot_dlp_rule", { name: "copilot-label-rule", policy: "copilot-policy", sensitivity_labels: ["guid-1", "guid-2"], action: "block_processing" }, "purview_manage_dlp");
    assert.deepEqual(calls.at(-1), { cmdlet: "New-DlpComplianceRule", params: {
      Name: "copilot-label-rule", Policy: "copilot-policy",
      ContentContainsSensitiveInformation: [{ operator: "And", groups: [{ operator: "Or", name: "Default", labels: [{ name: "guid-1", type: "Sensitivity" }, { name: "guid-2", type: "Sensitivity" }] }] }],
      RestrictAccess: [{ setting: "ExcludeContentProcessing", value: "Block" }],
    } });
    await call("get_label_policy_settings", {}, "purview_labels");
    assert.equal(calls.at(-1).path, "/me/security/informationProtection/labelPolicySettings");
    const first = await call("list_dlp_policies", {}, "purview_dlp");
    assert.equal(first.structuredContent.count, 25);
    const second = await call("list_dlp_policies", { cursor: first.structuredContent.next_cursor }, "purview_dlp");
    assert.equal(second.structuredContent.count, 5);
    assert.equal(second.structuredContent.has_more, false);
  }
});

test("execution cannot bypass policy, closed schemas or delete confirmation", async () => {
  const before = calls.length;
  await assert.rejects(() => executeCapability("set_dlp_rule", { identity: "x" }, { readOnly: true }), /not permitted/);
  await assert.rejects(() => executeCapability("remove_dlp_rule", { identity: "x" }), /confirm/);
  await assert.rejects(() => executeCapability("get_dlp_policy", { identity: "x", unexpected: true }), /Invalid arguments/);
  const dispatcher = createProjection({ mode: "dispatcher", policy: { readOnly: true } });
  await assert.rejects(() => dispatcher.call("purview_execute_capability", { capability_id: "set_dlp_rule", arguments: { identity: "x" } }), /not permitted/);
  const compact = createProjection({ mode: "compact" });
  await assert.rejects(() => compact.call("purview_dlp", { operation: "remove_dlp_rule", arguments: { identity: "x", confirm: true } }), /Invalid arguments/);
  assert.equal(calls.length, before);
});

test("safety switches accept common spellings and stop on anything else", () => {
  for (const value of ["true", "1", "YES", " True "]) assert.equal(policyFromEnvironment({ PURVIEW_READ_ONLY: value }).readOnly, true);
  for (const value of ["false", "0", "no"]) assert.equal(policyFromEnvironment({ PURVIEW_ALLOW_DESTRUCTIVE: value }).allowDestructive, false);
  assert.deepEqual([policyFromEnvironment({}).readOnly, policyFromEnvironment({}).allowDestructive], [false, true]);
  assert.throws(() => policyFromEnvironment({ PURVIEW_READ_ONLY: "on" }), /PURVIEW_READ_ONLY must be one of/);
});

test("get_auth_status reports the credential that will actually be used", () => {
  const status = (env) => authStatus({}, env).structuredContent;
  assert.deepEqual(status({}).missing, ["AZURE_TENANT_ID", "AZURE_CLIENT_ID"]);
  // Managed identity wins over a certificate path and needs no tenant or client ID.
  const mi = status({ PURVIEW_AUTH_MODE: "ManagedIdentity", AZURE_CLIENT_CERTIFICATE_PATH: "/c.pem" });
  assert.deepEqual([mi.mode, mi.missing, mi.graph_configured], ["managedidentity", [], true]);
  assert.equal(status({ AZURE_CLIENT_CERTIFICATE_PATH: "/c.pem" }).mode, "certificate");
  assert.equal(status({ PURVIEW_DLP_AUTH_MODE: "interactive" }).powershell_auth, "interactive");
  assert.throws(() => status({ PURVIEW_DLP_AUTH_MODE: "interacive" }), /PURVIEW_DLP_AUTH_MODE must be one of/);
  assert.equal(status({ PURVIEW_APP_ID: "a", PURVIEW_ORGANIZATION: "o", PURVIEW_CERT_THUMBPRINT: "t" }).powershell_auth, "certificate");
});

test("allow-list typos and short cursor secrets stop the server instead of hiding tools", async () => {
  const { createServer } = await import("../src/server.js");
  const { createListPaginator } = await import("../src/pagination.js");
  process.env.PURVIEW_ALLOWED_DOMAINS = "DLP,dlpp";
  try {
    assert.throws(() => createServer(), /PURVIEW_ALLOWED_DOMAINS has unknown values: dlpp/);
  } finally {
    delete process.env.PURVIEW_ALLOWED_DOMAINS;
  }
  assert.throws(() => createListPaginator({ secret: "short" }), /at least 32 characters/);
});

