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

const { capabilities, validateRegistry } = await import("../src/capabilities/registry.js");
const { createProjection, searchCapabilities, toolMode, searchLimit } = await import("../src/mcp/projection.js");
const { executeCapability } = await import("../src/dispatch/execute.js");
const { filterCapabilities } = await import("../src/retrieval/filters.js");
const { cases } = await import("../benchmarks/cases.js");

test("registry rejects missing metadata, unresolved handlers and colliding aliases", () => {
  assert.equal(capabilities.length, 37);
  assert.equal(validateRegistry(capabilities), capabilities);
  const c = capabilities[0];
  assert.throws(() => validateRegistry([c, { ...c, id: "other", aliases: [c.id] }]), /Duplicate/);
  assert.throws(() => validateRegistry([{ ...c, handler: undefined }]), /handler/);
  assert.throws(() => validateRegistry([{ ...c, domain: "" }]), /domain/);
});

test("representative intents retrieve expected capabilities in top eight deterministically", () => {
  for (const item of cases) {
    const ranked = searchCapabilities(item.query);
    assert.ok(ranked.some((r) => r.capability_id === item.expected), item.query);
    assert.deepEqual(searchCapabilities(item.query), ranked);
  }
  assert.equal(searchCapabilities("set_dlp_rule")[0].capability_id, "set_dlp_rule");
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

test("mode projections expose exact surfaces with conservative annotations", () => {
  assert.equal(createProjection({ mode: "full" }).tools.length, 37);
  assert.deepEqual(createProjection({ mode: "compact" }).tools.map((t) => t.name), [
    "purview_search", "purview_describe_capability", "purview_labels", "purview_manage_labels", "purview_dlp", "purview_manage_dlp", "purview_classification", "purview_auth",
  ]);
  assert.deepEqual(createProjection({ mode: "dispatcher" }).tools.map((t) => t.name), ["purview_search_capabilities", "purview_describe_capability", "purview_execute_capability"]);
  assert.equal(createProjection({ mode: "compact" }).tools.find((t) => t.name === "purview_manage_dlp").annotations.destructiveHint, true);
  assert.equal(createProjection({ mode: "compact", policy: { readOnly: true } }).tools.some((t) => t.name.includes("manage")), false);
  assert.throws(() => toolMode("typo"), /Invalid/);
  assert.throws(() => searchLimit(0), /integer/);
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

test("label groups and publishing targets enforce workflow constraints in every projection", async () => {
  for (const mode of ["full", "compact", "dispatcher"]) {
    const projection = createProjection({ mode });
    const call = (id, args) => mode === "full" ? projection.call(id, args)
      : mode === "compact" ? projection.call("purview_manage_labels", { operation: id, arguments: args })
        : projection.call("purview_execute_capability", { capability_id: id, arguments: args });
    const group = { name: "Group", display_name: "Group", is_label_group: true };
    await call("create_sensitivity_label", { ...group, color: "#123ABC", comment: "Organisation" });
    assert.deepEqual(calls.at(-1), { cmdlet: "New-Label", params: { Name: "Group", DisplayName: "Group", IsLabelGroup: true, Comment: "Organisation", AdvancedSettings: { color: "#123ABC" } } });
    for (const field of ["parent_id", "encryption", "content_marking", "site_and_group_protection", "teams_protection"]) {
      const before = calls.length;
      await assert.rejects(call("create_sensitivity_label", { ...group, [field]: field === "parent_id" ? "parent" : {} }), { code: "VALIDATION_ERROR" });
      assert.equal(calls.length, before, `Invalid group ${field} must not reach PowerShell`);
    }
    const before = calls.length;
    await assert.rejects(call("create_sensitivity_label", { name: "Label", display_name: "Label", is_label_group: false }), { code: "VALIDATION_ERROR" });
    assert.equal(calls.length, before);
    await call("create_sensitivity_label", { name: "Child", display_name: "Child", tooltip: "Child guidance", parent_id: "Group" });
    assert.deepEqual(calls.at(-1), { cmdlet: "New-Label", params: { Name: "Child", DisplayName: "Child", Tooltip: "Child guidance", ParentId: "Group" } });

    const policy = { name: "Policy", labels: ["Child"] };
    for (const targets of [{}, { exchange_location: [] }, { modern_group_location: [] }, { exchange_location: [], modern_group_location: [] }, { exchange_location: [""] }, { exchange_location: [" "] }]) {
      const before = calls.length;
      await assert.rejects(call("create_label_policy", { ...policy, ...targets }), (error) => error.code === "VALIDATION_ERROR" && /nonempty exchange_location or modern_group_location/.test(error.message));
      assert.equal(calls.length, before, "Invalid targets must not reach PowerShell");
    }
    for (const targets of [{ exchange_location: ["admin@contoso.com"] }, { modern_group_location: ["team@contoso.com"] }, { exchange_location: ["All"], modern_group_location: ["team@contoso.com"] }, { exchange_location: [], modern_group_location: ["team@contoso.com"] }]) {
      await call("create_label_policy", { ...policy, ...targets });
      assert.deepEqual(calls.at(-1), { cmdlet: "New-LabelPolicy", params: { Name: "Policy", Labels: ["Child"], ...(targets.exchange_location?.length ? { ExchangeLocation: targets.exchange_location } : {}), ...(targets.modern_group_location?.length ? { ModernGroupLocation: targets.modern_group_location } : {}) } });
    }
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

test("search is bounded, includes invocation and schema; auth diagnostics do not call backends", async () => {
  const p = createProjection({ mode: "compact", limit: 3 });
  const found = await p.call("purview_search", { query: "DLP policy" });
  assert.ok(found.structuredContent.count <= 3);
  assert.ok(found.structuredContent.items.every((c) => !c.input_schema && c.invocation.operation));
  const expanded = await p.call("purview_search", { query: "DLP policy", include_schemas: true });
  assert.ok(expanded.structuredContent.items.every((c) => c.input_schema));
  const detail = await p.call("purview_describe_capability", { capability_id: found.structuredContent.items[0].capability_id });
  assert.ok(detail.structuredContent.input_schema);
  assert.ok(detail.structuredContent.examples.length);
  await assert.rejects(() => p.call("purview_search", { query: "DLP", limit: 4 }), /Invalid arguments/);
  const before = calls.length;
  const auth = await p.call("purview_auth", { operation: "get_auth_status" });
  assert.equal(auth.structuredContent.credentials_verified, false);
  assert.equal(calls.length, before);
});
