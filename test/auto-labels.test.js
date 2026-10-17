import { test, mock } from "node:test";
import assert from "node:assert/strict";

const calls = [];
const policyId = "11111111-1111-1111-1111-111111111111", labelId = "22222222-2222-2222-2222-222222222222", ruleId = "33333333-3333-3333-3333-333333333333";
let policies, rules, label, missingRead, simulationCount, disappearAfterWrite;
function reset() {
  calls.length = 0; missingRead = false; simulationCount = 0; disappearAfterWrite = false;
  policies = [{ Name: "Finance", Guid: policyId, Mode: "Disable", ApplySensitivityLabel: labelId, SharePointLocation: ["https://contoso.sharepoint.com/sites/Finance"] }];
  rules = [{ Name: "Identifiers", Guid: ruleId, Policy: policyId, Workload: "SharePoint", Disabled: false }];
  label = { Name: "Confidential", Guid: labelId, IsLabelGroup: false, EncryptionEnabled: false };
}
async function invoke(cmdlet, params = {}) {
  calls.push({ cmdlet, params: structuredClone(params) });
  if (cmdlet === "Get-Label") return structuredClone(label);
  if (cmdlet === "Get-LabelPolicy") return [{ Name: "Published", Enabled: true, Labels: [labelId], ExchangeLocation: ["All"] }];
  const isRule = cmdlet.endsWith("Rule"), list = isRule ? rules : policies;
  if (cmdlet.startsWith("Get-")) return missingRead ? [] : structuredClone(params.Identity ? list.filter(x => x.Name === params.Identity || x.Guid === params.Identity) : list);
  if (cmdlet.startsWith("New-")) {
    list.push({ ...structuredClone(params), Guid: isRule ? ruleId : policyId }); return null;
  }
  if (cmdlet.startsWith("Set-")) {
    if (disappearAfterWrite) missingRead = true;
    const target = list.find(p => p.Guid === params.Identity);
    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith("Add")) target[k.slice(3)] = [...(target[k.slice(3)] ?? []), ...v];
      else if (k.startsWith("Remove")) target[k.slice(6)] = (target[k.slice(6)] ?? []).filter(x => !v.includes(x));
      else if (k !== "Identity") target[k] = structuredClone(v);
    }
    return null;
  }
  if (cmdlet.startsWith("Remove-")) { list.splice(list.findIndex(x => x.Guid === params.Identity), 1); return null; }
  throw new Error(cmdlet);
}
mock.module("../src/powershell.js", { namedExports: { powershell: { invoke, invokeSimulation: async (...args) => { simulationCount++; return invoke(...args); } } } });
mock.module("../src/graph.js", { namedExports: { appOnly: false, graphGet: async () => ({}) } });
const auto = await import("../src/auto-labels.js");
const { createProjection, routeFor } = await import("../src/mcp/projection.js");
const { capabilities } = await import("../src/capabilities/registry.js");
const { createDeletionConfirmation } = await import("../src/mcp/deletion-confirmation.js");
const conditions = { sensitive_information: { operator: "any", groups: [{ name: "Financial", operator: "any", detectors: [{ kind: "sit", identity: "Credit Card Number", min_count: 2, confidence_level: "High" }] }] } };
const writeCalls = () => calls.filter(c => !c.cmdlet.startsWith("Get-"));
async function call(projection, mode, id, args, ctx) {
  const route = routeFor(capabilities.find(c => c.id === id), mode);
  return projection.call(route.tool, mode === "full" ? args : { ...(mode === "compact" ? { operation: id } : { capability_id: id }), arguments: args }, ctx);
}

test("all projections expose ten auto-label operations without changing compact/dispatcher counts", async () => {
  for (const mode of ["full", "compact", "dispatcher"]) {
    reset(); const p = createProjection({ mode });
    assert.equal(p.tools.length, { full: 37, compact: 8, dispatcher: 3 }[mode]);
    const listed = await call(p, mode, "list_auto_label_policies", { workload: "SharePoint", limit: 1 });
    assert.equal(listed.structuredContent.count, 1);
    const detail = await call(p, mode, "get_auto_label_policy", { identity: "Finance", include_simulation_status: true, include_progress: true, include_distribution_detail: true, include_administrative_unit_details: true });
    assert.equal(detail.structuredContent.Guid, policyId);
    assert.deepEqual(calls.at(-1).params, { Identity: "Finance", IncludeTestModeResults: true, IncludeProgressFeedback: true, DistributionDetail: true, ForceValidate: true });
    await call(p, mode, "set_auto_label_policy", { identity: "Finance", mode: "Disable" });
    assert.equal(writeCalls().at(-1).params.Mode, "Disable");
  }
});
test("create validates publication and sends explicit disabled mode and canonical label GUID", async () => {
  reset(); policies = [];
  const result = await auto.createPolicy({ name: "Finance", behaviour: "apply", label_identity: "Confidential", locations: { sharepoint: { selection: "selected", include_sites: ["https://contoso.sharepoint.com/sites/Finance"] } } });
  assert.equal(result.object.Mode, "Disable");
  assert.deepEqual(writeCalls()[0].params, { Name: "Finance", Mode: "Disable", SharePointLocation: ["https://contoso.sharepoint.com/sites/Finance"], OneDriveLocation: [], ExchangeLocation: [], ApplySensitivityLabel: labelId });
});
test("scope replacement generates additions/removals and preserves omitted workloads", async () => {
  reset(); policies[0].ExchangeLocation = ["All"];
  await auto.setPolicy({ identity: "Finance", locations: { sharepoint: { selection: "selected", include_sites: ["https://contoso.sharepoint.com/sites/New"] } } });
  const params = writeCalls()[0].params;
  assert.deepEqual(params.AddSharePointLocation, ["https://contoso.sharepoint.com/sites/New"]);
  assert.deepEqual(params.RemoveSharePointLocation, ["https://contoso.sharepoint.com/sites/Finance"]);
  assert.equal(params.RemoveExchangeLocation, undefined);
  assert.deepEqual(policies[0].ExchangeLocation, ["All"]);
});
test("rule SIT conditions and exceptions map faithfully, including explicit false values", async () => {
  reset(); rules = [];
  const result = await auto.createRule({ name: "Identifiers", policy_identity: "Finance", workload: "SharePoint", conditions, exceptions: { document_name_contains_words: ["Synthetic"] }, disabled: false });
  assert.equal(result.object.Guid, ruleId);
  assert.deepEqual(writeCalls()[0].params.ContentContainsSensitiveInformation, [{ Name: "Credit Card Number", minCount: 2, minConfidence: 85 }]);
  assert.deepEqual(writeCalls()[0].params.ExceptIfDocumentNameMatchesWords, ["Synthetic"]);
  assert.equal(writeCalls()[0].params.Disabled, false);
});
test("location deltas retain other sites and reject overlapping additions/removals", async () => {
  reset();
  await auto.setPolicy({ identity: "Finance", location_changes: { sharepoint: { include_sites: { add: ["https://contoso.sharepoint.com/sites/New"] } } } });
  assert.deepEqual(policies[0].SharePointLocation, ["https://contoso.sharepoint.com/sites/Finance", "https://contoso.sharepoint.com/sites/New"]);
  calls.length = 0;
  await assert.rejects(auto.setPolicy({ identity: "Finance", location_changes: { sharepoint: { include_sites: { add: ["https://contoso.sharepoint.com/sites/New"], remove: ["https://contoso.sharepoint.com/sites/New"] } } } }), /added and removed/);
  assert.equal(writeCalls().length, 0);
});
test("closed schemas and host authorization deny writes in every projection", async () => {
  for (const mode of ["full", "compact", "dispatcher"]) {
    reset(); const p = createProjection({ mode, authorize: () => false });
    await assert.rejects(call(p, mode, "set_auto_label_policy", { identity: "Finance", mode: "Disable" }), { code: "POLICY_DENIED" });
    await assert.rejects(call(p, mode, "set_auto_label_rule", { identity: "Identifiers", priority: 1 }), { code: "VALIDATION_ERROR" });
    assert.equal(calls.length, 0);
  }
});
test("policy pagination preserves filters and missing identity never returns an unrelated object", async () => {
  reset(); policies.push({ ...policies[0], Name: "Finance 2", Guid: "44444444-4444-4444-4444-444444444444" });
  const p = createProjection({ mode: "full" });
  const first = await p.call("list_auto_label_policies", { name_contains: "Finance", limit: 1 });
  assert.equal(first.structuredContent.has_more, true);
  const next = await p.call("list_auto_label_policies", { name_contains: "Finance", limit: 1, cursor: first.structuredContent.next_cursor });
  assert.notEqual(next.structuredContent.items[0].Guid, first.structuredContent.items[0].Guid);
  await assert.rejects(p.call("list_auto_label_policies", { name_contains: "Other", limit: 1, cursor: first.structuredContent.next_cursor }), /cursor/);
  await assert.rejects(auto.getPolicy("Missing"), { code: "TARGET_NOT_FOUND" });
});
test("unknown identities, stale revisions, unsupported features and workload mismatches never mutate", async () => {
  const attempts = [
    () => auto.setPolicy({ identity: "Missing", mode: "Disable" }),
    () => auto.setPolicy({ identity: "Finance", expected_revision: "stale", mode: "Disable" }),
    () => auto.setPolicy({ identity: "Finance", retry_distribution: true, description: "changed" }),
    () => auto.setPolicy({ identity: "Finance", mode: "Enable", restart_simulation: true }),
    () => auto.setPolicy({ identity: "Finance", enabled: true }),
    () => auto.setPolicy({ identity: "Finance", mode: "TestWithoutNotifications", restart_simulation: true, auto_enable_after: "1.00:00:00" }),
    () => auto.createRule({ name: "Other", policy_identity: "Finance", workload: "Exchange", conditions }),
    () => auto.setRule({ identity: "Identifiers", expression: { all: [] } }),
    () => auto.setRule({ identity: "Identifiers", conditions: { subject_matches_patterns: ["x"] } }),
  ];
  for (const attempt of attempts) { reset(); await assert.rejects(attempt); assert.equal(writeCalls().length, 0); }
  reset(); calls.length = 0;
  await assert.rejects(auto.getPolicy(""), /Identity/);
});
test("simulation uses the simulation bridge, then allows only the unchanged simulated configuration", async () => {
  reset();
  await assert.rejects(auto.setPolicy({ identity: "Finance", mode: "Enable", expected_revision: (await auto.getPolicy("Finance")).revision }), { code: "SIMULATION_REQUIRED" });
  const simulated = await auto.setPolicy({ identity: "Finance", mode: "TestWithoutNotifications", restart_simulation: true });
  assert.equal(simulationCount, 1);
  await assert.rejects(auto.setPolicy({ identity: "Finance", mode: "Enable", expected_revision: simulated.object.revision }), { code: "SIMULATION_REQUIRED" });
  policies[0].SimulationStatus = "Completed";
  await auto.setPolicy({ identity: "Finance", mode: "Enable", expected_revision: (await auto.getPolicy("Finance")).revision });
  assert.equal(policies[0].Mode, "Enable");
  await auto.setPolicy({ identity: "Finance", mode: "Disable" });
  rules[0].Comment = "changed externally";
  const before = writeCalls().length;
  await assert.rejects(auto.setPolicy({ identity: "Finance", mode: "Enable", expected_revision: (await auto.getPolicy("Finance")).revision }), { code: "SIMULATION_REQUIRED" });
  assert.equal(writeCalls().length, before);
});
test("active policy blocks rule edits and combined edit/enable", async () => {
  reset(); policies[0].Mode = "Enable";
  await assert.rejects(auto.setRule({ identity: "Identifiers", disabled: true }), /Disable/);
  await assert.rejects(auto.setPolicy({ identity: "Finance", mode: "Enable", expected_revision: (await auto.getPolicy("Finance")).revision, priority: 1 }), /separately/);
  assert.equal(writeCalls().length, 0);
});
test("both auto-label deletions resolve canonical targets and require bound elicitation", async () => {
  for (const id of ["remove_auto_label_policy", "remove_auto_label_rule"]) {
    reset();
    const guard = createDeletionConfirmation({ principal: "admin", client: "test", tenant: "tenant", store: new Map() });
    const p = createProjection({ mode: "full", confirmDeletion: guard });
    const ctx = (state, response) => ({ clientCapabilities: { elicitation: { form: {} } }, mcpReq: { envelope: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" }, requestState: () => state, inputResponses: response ? { confirm_deletion: response } : undefined } });
    const args = { identity: id.endsWith("policy") ? "Finance" : "Identifiers" };
    const first = await p.call(id, args, ctx());
    assert.equal(first.resultType, "input_required"); assert.equal(writeCalls().length, 0);
    assert.match(first.inputRequests.confirm_deletion.params.message, /not reversed/);
    await p.call(id, args, ctx(first.requestState, { action: "accept", content: { confirm: true } }));
    assert.equal(writeCalls()[0].params.Identity, id.endsWith("policy") ? policyId : ruleId);
  }
});
test("readback failure reports an uncertain accepted write without retrying it", async () => {
  reset();
  disappearAfterWrite = true;
  await assert.rejects(auto.setPolicy({ identity: "Finance", description: "changed" }), { code: "READBACK_FAILED" });
  assert.equal(writeCalls().length, 1);
});
