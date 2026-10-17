import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { oneDriveCreate, oneDriveUpdate, assertExchangeOnly, assertLocationExceptions } from "../src/dlp-validation.js";

const calls = [];
let current = {};
mock.module("../src/powershell.js", { namedExports: { powershell: { invoke: async (cmdlet, params, props) => {
  calls.push({ cmdlet, params, props });
  if (cmdlet === "Get-DlpCompliancePolicy") return current;
  if (cmdlet === "Get-DlpComplianceRule") return { ParentPolicyName: "P1" };
  return { Name: "Example" };
} } } });
const { createProjection } = await import("../src/mcp/projection.js");
const dlp = await import("../src/dlp.js");

test("alert recipients and Exchange exception checks apply in every projection", async () => {
  for (const mode of ["full", "compact", "dispatcher"]) {
    const p = createProjection({ mode });
    const invoke = (id, args) => mode === "full" ? p.call(id, args) : mode === "compact"
      ? p.call("purview_manage_dlp", { operation: id, arguments: args })
      : p.call("purview_execute_capability", { capability_id: id, arguments: args });
    for (const value of [true, false, [], ["Owner"], ["not-an-address"]]) {
      calls.length = 0;
      await assert.rejects(invoke("set_dlp_rule", { identity: "R1", generate_alert: value }), { code: "VALIDATION_ERROR" });
      assert.equal(calls.length, 0);
    }
    await invoke("set_dlp_rule", { identity: "R1", generate_alert: ["security@contoso.com", "SiteAdmin"] });
    assert.deepEqual(calls.at(-1).params.GenerateAlert, ["security@contoso.com", "SiteAdmin"]);
    current = { Workload: "Exchange, SharePoint", SharePointLocation: ["All"] };
    for (const id of ["create_dlp_rule", "set_dlp_rule"]) {
      calls.length = 0;
      const args = id.startsWith("create") ? { name: "R1", policy: "P1" } : { identity: "R1" };
      await assert.rejects(invoke(id, { ...args, exceptions: { from: ["sender@contoso.com"] } }), { code: "VALIDATION_ERROR" });
      assert.ok(calls.every((c) => c.cmdlet.startsWith("Get-")));
    }
    current = { Workload: "Exchange", ExchangeLocation: ["All"] };
    await invoke("set_dlp_rule", { identity: "R1", exceptions: { sent_to: ["recipient@contoso.com"] } });
    assert.deepEqual(calls.at(-1).params.ExceptIfSentTo, ["recipient@contoso.com"]);
  }
});

test("SIT confidence uses documented grouped OR conditions and numeric bounds", () => {
  for (const [level, expected] of [["Low", 65], ["Medium", 75], ["High", 85]]) {
    const result = dlp.sensitiveInformationTypeConditions(["Credit Card Number", { name: "Employee ID", min_count: 2, max_count: -1, confidence_level: level }]);
    assert.deepEqual(result, [{ operator: "And", groups: [{ operator: "Or", name: "Default", sensitivetypes: [
      { Name: "Credit Card Number" }, { Name: "Employee ID", minCount: 2, maxCount: -1, minConfidence: expected, maxConfidence: 100 },
    ] }] }]);
    assert.ok(!JSON.stringify(result).includes("confidenceLevel"));
  }
});

test("OneDrive create maps UPN scopes, rejects URLs and incompatible exclusions", () => {
  assert.deepEqual(oneDriveCreate({ onedrive_location: ["a@contoso.com"] }), { OneDriveLocation: ["All"], OneDriveSharedBy: ["a@contoso.com"] });
  assert.deepEqual(oneDriveCreate({ location_exceptions: { onedrive: ["b@contoso.com"] } }), { OneDriveLocation: ["All"], ExceptIfOneDriveSharedBy: ["b@contoso.com"] });
  assert.throws(() => oneDriveCreate({ onedrive_location: ["https://contoso-my.sharepoint.com/personal/a"] }), /UPNs/);
  assert.throws(() => oneDriveCreate({ onedrive_location: ["a@contoso.com"], location_exceptions: { onedrive: ["b@contoso.com"] } }), /cannot be combined/);
  assert.throws(() => oneDriveCreate({ onedrive_location: [], location_exceptions: { onedrive: ["b@contoso.com"] } }), /disabling/);
});

test("OneDrive edits preserve unrelated users and reject implicit scope changes", () => {
  const policy = { OneDriveLocation: ["All"], ExceptIfOneDriveSharedBy: ["old@contoso.com", "keep@contoso.com"] };
  const args = { add_location_exceptions: { onedrive: ["new@contoso.com"] }, remove_location_exceptions: { onedrive: ["OLD@contoso.com"] } };
  assert.deepEqual(oneDriveUpdate(args, policy), { ExceptIfOneDriveSharedBy: ["keep@contoso.com", "new@contoso.com"] });
  assert.deepEqual(oneDriveUpdate({ remove_location_exceptions: { onedrive: ["old@contoso.com", "keep@contoso.com"] } }, policy), { ExceptIfOneDriveSharedBy: null });
  assert.throws(() => oneDriveUpdate(args, { ...policy, OneDriveSharedByMemberOf: ["group@contoso.com"] }), /cannot be combined/);
  assert.throws(() => oneDriveUpdate({ remove_locations: { onedrive: ["a@contoso.com"] } }, { OneDriveLocation: ["All"], OneDriveSharedBy: ["a@contoso.com"] }), /broaden/);
  assert.throws(() => oneDriveUpdate({ add_locations: { onedrive: ["a@contoso.com"] } }, { OneDriveLocation: ["All"] }), /silently narrow/);
  assert.throws(() => oneDriveUpdate(args, {}), /Cannot verify/);
  assert.deepEqual(oneDriveUpdate({ remove_locations: { onedrive: ["All"] } }, policy), { RemoveOneDriveLocation: ["All"] });
});

test("policy handlers never emit obsolete OneDrive parameters and show correct scope", async () => {
  const p = createProjection({ mode: "full" });
  await p.call("create_dlp_policy", { name: "P1", location_exceptions: { onedrive: ["a@contoso.com"] } });
  assert.deepEqual(calls.at(-1).params, { Name: "P1", OneDriveLocation: ["All"], ExceptIfOneDriveSharedBy: ["a@contoso.com"] });
  current = { Name: "P1", OneDriveLocation: ["All"], ExceptIfOneDriveSharedBy: ["a@contoso.com"] };
  await p.call("set_dlp_policy", { identity: "P1", add_location_exceptions: { onedrive: ["b@contoso.com"] } });
  assert.deepEqual(calls.at(-1).params, { Identity: "P1", ExceptIfOneDriveSharedBy: ["a@contoso.com", "b@contoso.com"] });
  assert.match(dlp.formatPolicyDetail({ Name: "P1", OneDriveLocation: ["All"], OneDriveSharedBy: ["a@contoso.com"] }), /OneDrive \(1 users, 0 groups\)/);
  const before = calls.length;
  await assert.rejects(p.call("create_dlp_policy", { name: "P1", sharepoint_location: ["https://one"], location_exceptions: { sharepoint: ["https://two"] } }), { code: "VALIDATION_ERROR" });
  assert.equal(calls.length, before);
});

test("scope validation fails closed on missing workloads and requires All for exceptions", () => {
  assert.throws(() => assertExchangeOnly(undefined), /verified Exchange-only/);
  assert.throws(() => assertLocationExceptions({ TeamsLocationException: ["a@contoso.com"] }), /All scope/);
  assert.doesNotThrow(() => assertLocationExceptions({ AddTeamsLocationException: ["a@contoso.com"] }, { TeamsLocation: ["All"] }));
});
