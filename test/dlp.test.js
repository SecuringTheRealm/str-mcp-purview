import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { oneDriveCreate, oneDriveUpdate, assertExchangeOnly, assertLocationExceptions } from "../src/dlp-validation.js";

// dlp.js delegates execution to the powershell bridge; mock it so no pwsh runs.
const calls = [];
let current = {};
let invokeImpl = null;
mock.module("../src/powershell.js", { namedExports: { powershell: { invoke: async (cmdlet, params, props) => {
  calls.push({ cmdlet, params, props });
  if (invokeImpl) return invokeImpl(cmdlet, params, props);
  if (cmdlet === "Get-DlpCompliancePolicy") return current;
  if (cmdlet === "Get-DlpComplianceRule") return { ParentPolicyName: "P1" };
  return { Name: "Example" };
} } } });
const { createProjection } = await import("../src/mcp/projection.js");
const dlp = await import("../src/dlp.js");

beforeEach(() => {
  calls.length = 0;
  current = {};
  invokeImpl = null;
});

test("setRule suppresses the confirmation pause and keeps the update params", async () => {
  await dlp.setRule({ Identity: "Rule1", Disabled: true });
  assert.equal(calls.at(-1).cmdlet, "Set-DlpComplianceRule");
  assert.deepEqual(calls.at(-1).params, { Identity: "Rule1", Disabled: true, Confirm: false });
});

test("read helpers normalise null to [] and return the first match or undefined", async () => {
  invokeImpl = async () => null;
  assert.deepEqual(await dlp.listPolicies(), []);
  assert.equal(await dlp.getRule("missing"), undefined);
  invokeImpl = async () => [{ Name: "P1" }, { Name: "P2" }];
  assert.deepEqual(await dlp.getPolicy("P1"), { Name: "P1" });
  assert.deepEqual(calls.at(-1).params, { Identity: "P1" });
});

test("filterPolicies and filterRules apply their filters", () => {
  const policies = [
    { Name: "P1", Mode: "Enable", Workload: "Exchange" },
    { Name: "P2", Mode: "TestWithNotifications", Workload: "EndpointDevices" },
  ];
  const rules = [{ Name: "R1", Disabled: true, BlockAccess: false }, { Name: "R2", Disabled: false, BlockAccess: true }];
  const names = (xs) => xs.map((x) => x.Name);
  assert.equal(dlp.filterPolicies(policies).length, 2);
  assert.deepEqual(names(dlp.filterPolicies(policies, { mode: "enable" })), ["P1"]);
  assert.deepEqual(names(dlp.filterPolicies(policies, { workload: "endpoint" })), ["P2"]);
  assert.deepEqual(names(dlp.filterRules(rules, { disabledOnly: true })), ["R1"]);
  assert.deepEqual(names(dlp.filterRules(rules, { blockingOnly: true })), ["R2"]);
});

test("listSensitiveInformationTypes filters by scope and name_contains", async () => {
  invokeImpl = async () => [
    { Name: "Credit Card Number", Publisher: "Microsoft Corporation" },
    { Name: "EU Debit Card Number", Publisher: "Microsoft Corporation" },
    { Name: "Employee ID", Publisher: "Contoso" },
    { Name: "Badge Number", Publisher: "" },
  ];
  const names = async (...args) => (await dlp.listSensitiveInformationTypes(...args)).map((s) => s.Name);
  assert.equal((await names()).length, 4);
  assert.deepEqual(await names("custom"), ["Employee ID", "Badge Number"]);
  assert.deepEqual(await names("all", "card"), ["Credit Card Number", "EU Debit Card Number"]);
});

test("formatters render the SIT condition (an empty condition was a past bug)", () => {
  const sit = [{ groups: [{ sensitivetypes: [{ name: "Credit Card Number" }] }] }];
  assert.match(dlp.formatRuleList([{ Name: "R1", Priority: 0, ContentContainsSensitiveInformation: sit }]), /\[SIT: Credit Card Number\]/);
  assert.match(dlp.formatRuleDetail({ Name: "R1", Priority: 0, ContentContainsSensitiveInformation: sit }), /Detected sensitive info:.*Credit Card Number/);
});

test("copilotLocations maps tenant-wide and per-user inclusions", () => {
  const all = JSON.parse(dlp.copilotLocations())[0];
  assert.equal(all.Workload, "Applications");
  assert.deepEqual(all.Inclusions, [{ Type: "Tenant", Identity: "All" }]);
  assert.deepEqual(JSON.parse(dlp.copilotLocations(["a@contoso.com", "b@contoso.com"]))[0].Inclusions, [
    { Type: "User", Identity: "a@contoso.com" },
    { Type: "User", Identity: "b@contoso.com" },
  ]);
});

test("copilotCondition maps SITs and labels and rejects a missing condition", () => {
  assert.deepEqual(dlp.copilotCondition({ sits: ["Credit Card Number"] }), [{ Name: "Credit Card Number" }]);
  assert.deepEqual(dlp.copilotCondition({ labels: ["guid-1", "guid-2"] }), [{ operator: "And", groups: [{ operator: "Or", name: "Default", labels: [{ name: "guid-1", type: "Sensitivity" }, { name: "guid-2", type: "Sensitivity" }] }] }]);
  assert.throws(() => dlp.copilotCondition({}), { code: "VALIDATION_ERROR", message: /needs a condition/ });
});

test("SIT conditions keep the string form and map confidence to numeric bounds in a grouped OR", () => {
  assert.deepEqual(dlp.sensitiveInformationTypeConditions(["Credit Card Number"]), [{ Name: "Credit Card Number" }]);
  for (const [level, expected] of [["Low", 65], ["Medium", 75], ["High", 85]]) {
    const result = dlp.sensitiveInformationTypeConditions(["Credit Card Number", { name: "Employee ID", min_count: 2, max_count: -1, confidence_level: level }]);
    assert.deepEqual(result, [{ operator: "And", groups: [{ operator: "Or", name: "Default", sensitivetypes: [
      { Name: "Credit Card Number" }, { Name: "Employee ID", minCount: 2, maxCount: -1, minConfidence: expected, maxConfidence: 100 },
    ] }] }]);
    assert.ok(!JSON.stringify(result).includes("confidenceLevel"));
  }
});

test("SIT conditions reject a finite max_count below min_count", () => {
  assert.throws(
    () => dlp.sensitiveInformationTypeConditions([{ name: "Credit Card Number", min_count: 5, max_count: 2 }]),
    /max_count must be -1.*at least min_count/
  );
});

test("ruleWriteParams maps tool arguments to Purview cmdlet parameters", () => {
  assert.deepEqual(dlp.ruleWriteParams({
    sensitive_information_types: ["Credit Card Number"],
    block_access: true,
    notify_user: ["LastModifier"],
    generate_alert: ["security@contoso.com"],
    priority: 3,
    disabled: false,
    access_scope: "NotInOrganization",
    report_severity_level: "High",
    notification_email_subject: "Sensitive content detected",
    notification_email_body: "Review %%MatchedConditions%%",
    policy_tip_text: "Do not share this externally.",
    exceptions: {
      sensitive_information_types: [{ name: "Employee ID", min_count: 1 }],
      sender_domain_is: ["trusted.example"],
      document_name_matches_words: ["approved-template"],
    },
  }), {
    ContentContainsSensitiveInformation: [{ Name: "Credit Card Number" }],
    BlockAccess: true,
    NotifyUser: ["LastModifier"],
    GenerateAlert: ["security@contoso.com"],
    Priority: 3,
    Disabled: false,
    AccessScope: "NotInOrganization",
    ReportSeverityLevel: "High",
    NotifyEmailCustomSubject: "Sensitive content detected",
    NotifyEmailCustomText: "Review %%MatchedConditions%%",
    NotifyPolicyTipCustomText: "Do not share this externally.",
    ExceptIfContentContainsSensitiveInformation: [{ Name: "Employee ID", minCount: 1 }],
    ExceptIfDocumentNameMatchesWords: ["approved-template"],
    ExceptIfSenderDomainIs: ["trusted.example"],
  });
});

test("policy location exception params map create and update forms", () => {
  assert.deepEqual(
    dlp.createPolicyLocationExceptionParams({ sharepoint: ["https://contoso.sharepoint.com/sites/allowed"], endpoint: ["excluded@contoso.com"] }),
    { SharePointLocationException: ["https://contoso.sharepoint.com/sites/allowed"], EndpointDlpLocationException: ["excluded@contoso.com"] }
  );
  assert.deepEqual(
    dlp.updatePolicyLocationExceptionParams({ teams: ["add@contoso.com"] }, { teams: ["remove@contoso.com"] }),
    { AddTeamsLocationException: ["add@contoso.com"], RemoveTeamsLocationException: ["remove@contoso.com"] }
  );
});

// Corrections (formerly dlp-corrections.test.js)

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

test("set tools reject arguments that map to no change instead of reporting success", async () => {
  const p = createProjection({ mode: "full" });
  for (const [id, args] of [
    ["set_dlp_rule", { identity: "R1", notify_user: [], endpoint_restrictions: [], exceptions: { from: [] } }],
    ["set_dlp_policy", { identity: "P1", add_locations: { teams: [] } }],
  ]) {
    calls.length = 0;
    await assert.rejects(p.call(id, args), { code: "VALIDATION_ERROR", message: /No changes supplied/ });
    assert.equal(calls.length, 0);
  }
});

test("an empty comment clears the policy comment rather than being dropped", async () => {
  await createProjection({ mode: "full" }).call("set_dlp_policy", { identity: "P1", comment: "" });
  assert.deepEqual(calls.at(-1).params, { Identity: "P1", Comment: "" });
});

test("Copilot block_web_search rejects a sensitivity-label condition", async () => {
  const p = createProjection({ mode: "full" });
  await assert.rejects(p.call("create_copilot_dlp_rule", { name: "R", policy: "P", sensitivity_labels: ["guid-1"], action: "block_web_search" }), { code: "VALIDATION_ERROR", message: /block_web_search/ });
  assert.equal(calls.length, 0);
  await p.call("create_copilot_dlp_rule", { name: "R", policy: "P", sensitivity_labels: ["guid-1"] });
  await p.call("create_copilot_dlp_rule", { name: "R", policy: "P", sensitive_information_types: ["Credit Card Number"], action: "block_web_search" });
  assert.equal(calls.at(-1).params.RestrictWebGrounding, true);
});

test("handler validation failures carry VALIDATION_ERROR, not BACKEND_ERROR", async () => {
  const p = createProjection({ mode: "full" });
  for (const [id, args] of [
    ["create_endpoint_dlp_rule", { name: "R", policy: "P", endpoint_restrictions: [{ activity: "Print", action: "Block" }] }],
    ["set_dlp_rule", { identity: "R1", sensitive_information_types: [{ name: "Credit Card Number", min_count: 5, max_count: 2 }] }],
    ["get_dlp_rule", { identity: "" }],
    ["create_copilot_dlp_rule", { name: "R", policy: "P", sensitive_information_types: [] }],
    ["create_copilot_dlp_rule", { name: "R", policy: "P", sensitive_information_types: ["x"], sensitivity_labels: ["y"] }],
  ]) {
    calls.length = 0;
    await assert.rejects(p.call(id, args), { code: "VALIDATION_ERROR" }, id);
    assert.ok(calls.every((c) => c.cmdlet.startsWith("Get-")), id);
  }
});
