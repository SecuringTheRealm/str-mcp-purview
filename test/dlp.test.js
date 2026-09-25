import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// dlp.js delegates all execution to the powershell bridge singleton; mock it
// so the data-access functions can be exercised deterministically without a
// real pwsh process.
const invokeCalls = [];
let invokeImpl = async () => null;

mock.module("../src/powershell.js", {
  namedExports: {
    powershell: {
      invoke: async (cmdlet, params, selectProps) => {
        invokeCalls.push({ cmdlet, params, selectProps });
        return invokeImpl(cmdlet, params, selectProps);
      },
    },
  },
});

const dlp = await import("../src/dlp.js");

test("listPolicies", async (t) => {
  await t.test("invokes Get-DlpCompliancePolicy and normalises the result to an array", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => ({ Name: "Policy1" });
    const result = await dlp.listPolicies();
    assert.deepEqual(result, [{ Name: "Policy1" }]);
    assert.equal(invokeCalls.at(-1).cmdlet, "Get-DlpCompliancePolicy");
    assert.deepEqual(invokeCalls.at(-1).params, {});
  });

  await t.test("returns an empty array when there are no policies", async () => {
    invokeImpl = async () => null;
    assert.deepEqual(await dlp.listPolicies(), []);
  });
});

test("getPolicy", async (t) => {
  await t.test("passes Identity through and returns the first match", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => [{ Name: "P1" }, { Name: "P2" }];
    const result = await dlp.getPolicy("P1");
    assert.deepEqual(result, { Name: "P1" });
    assert.deepEqual(invokeCalls.at(-1).params, { Identity: "P1" });
  });

  await t.test("returns undefined when nothing matches", async () => {
    invokeImpl = async () => null;
    assert.equal(await dlp.getPolicy("missing"), undefined);
  });
});

test("listRules", async (t) => {
  await t.test("omits the Policy parameter when not given", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => [];
    await dlp.listRules();
    assert.deepEqual(invokeCalls.at(-1).params, {});
  });

  await t.test("includes the Policy parameter when given", async () => {
    invokeImpl = async () => [];
    await dlp.listRules("MyPolicy");
    assert.deepEqual(invokeCalls.at(-1).params, { Policy: "MyPolicy" });
  });

  await t.test("selects full rule properties for a paginated policy detail read", async () => {
    invokeImpl = async () => [];
    await dlp.listRules("MyPolicy", { detail: true });
    assert.deepEqual(invokeCalls.at(-1).params, { Policy: "MyPolicy" });
    assert.ok(invokeCalls.at(-1).selectProps.includes("StopPolicyProcessing"));
    assert.ok(invokeCalls.at(-1).selectProps.includes("ExceptIfSenderDomainIs"));
  });
});

test("getRule", async (t) => {
  await t.test("passes Identity through and returns the first match", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => [{ Name: "R1" }];
    const result = await dlp.getRule("R1");
    assert.deepEqual(result, { Name: "R1" });
    assert.equal(invokeCalls.at(-1).cmdlet, "Get-DlpComplianceRule");
    assert.deepEqual(invokeCalls.at(-1).params, { Identity: "R1" });
  });

  await t.test("returns undefined when nothing matches", async () => {
    invokeImpl = async () => null;
    assert.equal(await dlp.getRule("missing"), undefined);
  });
});

test("filterPolicies", async (t) => {
  const policies = [
    { Name: "P1", Mode: "Enable", Workload: "Exchange" },
    { Name: "P2", Mode: "TestWithNotifications", Workload: "EndpointDevices" },
  ];
  await t.test("returns all when no filter", () => {
    assert.equal(dlp.filterPolicies(policies).length, 2);
  });
  await t.test("filters by exact mode (case-insensitive)", () => {
    const out = dlp.filterPolicies(policies, { mode: "enable" });
    assert.deepEqual(out.map((p) => p.Name), ["P1"]);
  });
  await t.test("filters by workload substring", () => {
    const out = dlp.filterPolicies(policies, { workload: "endpoint" });
    assert.deepEqual(out.map((p) => p.Name), ["P2"]);
  });
});

test("filterRules", async (t) => {
  const rules = [
    { Name: "R1", Disabled: true, BlockAccess: false },
    { Name: "R2", Disabled: false, BlockAccess: true },
  ];
  await t.test("disabledOnly keeps only disabled", () => {
    assert.deepEqual(dlp.filterRules(rules, { disabledOnly: true }).map((r) => r.Name), ["R1"]);
  });
  await t.test("blockingOnly keeps only blocking", () => {
    assert.deepEqual(dlp.filterRules(rules, { blockingOnly: true }).map((r) => r.Name), ["R2"]);
  });
});

test("formatRuleDetail", async (t) => {
  await t.test("reports not found for a nullish rule", () => {
    assert.equal(dlp.formatRuleDetail(null), "DLP rule not found.");
  });

  await t.test("renders a heading, bullet fields, and detected SITs", () => {
    const out = dlp.formatRuleDetail({
      Name: "R1",
      ParentPolicyName: "P1",
      Priority: 0,
      BlockAccess: true,
      ContentContainsSensitiveInformation: [{ groups: [{ sensitivetypes: [{ name: "Credit Card Number" }] }] }],
    });
    assert.match(out, /^# DLP rule: R1/);
    assert.match(out, /- \*\*Policy:\*\* P1/);
    assert.match(out, /- \*\*Block access:\*\* true/);
    assert.match(out, /Detected sensitive info:.*Credit Card Number/);
  });

  await t.test("surfaces scope, severity, exceptions, restrictions, and customised notifications", () => {
    const out = dlp.formatRuleDetail({
      Name: "R1",
      Priority: 0,
      StopPolicyProcessing: true,
      RestrictAccess: [{ setting: "ExcludeContentProcessing", value: "Block" }],
      AccessScope: "NotInOrganization",
      ReportSeverityLevel: "High",
      ExceptIfSenderDomainIs: ["contoso.com"],
      ExceptIfDocumentNameMatchesWords: ["template"],
      NotifyEmailCustomSubject: "Sensitive content",
      NotifyPolicyTipCustomText: "Careful!",
    });
    assert.match(out, /- \*\*Stops later rules:\*\* true/);
    assert.match(out, /- \*\*Restrict access:\*\* ExcludeContentProcessing=Block/);
    assert.match(out, /- \*\*Access scope:\*\* NotInOrganization/);
    assert.match(out, /- \*\*Severity:\*\* High/);
    assert.match(out, /- \*\*Exceptions:\*\* doc-name, sender-domain/);
    assert.match(out, /- \*\*Notification email:\*\* customised/);
    assert.match(out, /- \*\*Policy tip:\*\* configured/);
  });

  await t.test("degrades gracefully on a lean object (bulk path) — no detail lines", () => {
    const out = dlp.formatRuleDetail({ Name: "R1", Priority: 0 });
    assert.doesNotMatch(out, /Exceptions:|Restrict access:|Policy tip:/);
  });
});

test("formatRuleDetails", async (t) => {
  await t.test("reports none found, scoped to the policy name", () => {
    assert.equal(dlp.formatRuleDetails([], "P1"), 'No DLP rules found in policy "P1".');
  });

  await t.test("renders an intro count plus a detail block per rule", () => {
    const out = dlp.formatRuleDetails([{ Name: "R1", Priority: 0 }, { Name: "R2", Priority: 1 }], "P1");
    assert.match(out, /^2 DLP rule\(s\) in policy: P1:/);
    assert.match(out, /# DLP rule: R1/);
    assert.match(out, /# DLP rule: R2/);
  });
});

test("createPolicy / setPolicy / createRule / setRule", async (t) => {
  await t.test("createPolicy invokes New-DlpCompliancePolicy with the given params", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => ({ Name: "New1" });
    await dlp.createPolicy({ Name: "New1" });
    assert.equal(invokeCalls.at(-1).cmdlet, "New-DlpCompliancePolicy");
    assert.deepEqual(invokeCalls.at(-1).params, { Name: "New1" });
  });

  await t.test("setPolicy invokes Set-DlpCompliancePolicy with the given params", async () => {
    invokeImpl = async () => ({ Name: "P1", Mode: "Enable" });
    await dlp.setPolicy({ Identity: "P1", Mode: "Enable" });
    assert.equal(invokeCalls.at(-1).cmdlet, "Set-DlpCompliancePolicy");
    assert.deepEqual(invokeCalls.at(-1).params, { Identity: "P1", Mode: "Enable" });
  });

  await t.test("createRule invokes New-DlpComplianceRule with the given params", async () => {
    invokeImpl = async () => ({ Name: "Rule1" });
    await dlp.createRule({ Name: "Rule1", Policy: "P1" });
    assert.equal(invokeCalls.at(-1).cmdlet, "New-DlpComplianceRule");
  });

  await t.test("setRule invokes Set-DlpComplianceRule with the given params", async () => {
    invokeImpl = async () => ({ Name: "Rule1" });
    await dlp.setRule({ Identity: "Rule1", Disabled: true });
    assert.equal(invokeCalls.at(-1).cmdlet, "Set-DlpComplianceRule");
    assert.deepEqual(invokeCalls.at(-1).params, { Identity: "Rule1", Disabled: true });
  });

  await t.test("removePolicy invokes Remove-DlpCompliancePolicy with Confirm:false", async () => {
    invokeImpl = async () => null;
    await dlp.removePolicy({ Identity: "P1", Confirm: false });
    assert.equal(invokeCalls.at(-1).cmdlet, "Remove-DlpCompliancePolicy");
    assert.deepEqual(invokeCalls.at(-1).params, { Identity: "P1", Confirm: false });
  });

  await t.test("removeRule invokes Remove-DlpComplianceRule", async () => {
    invokeImpl = async () => null;
    await dlp.removeRule({ Identity: "Rule1", Confirm: false });
    assert.equal(invokeCalls.at(-1).cmdlet, "Remove-DlpComplianceRule");
  });
});

test("copilotLocations", async (t) => {
  await t.test("defaults to a tenant-wide (All) inclusion", () => {
    const loc = JSON.parse(dlp.copilotLocations());
    assert.equal(loc[0].Workload, "Applications");
    assert.deepEqual(loc[0].Inclusions, [{ Type: "Tenant", Identity: "All" }]);
  });

  await t.test("maps specific users to User inclusions", () => {
    const loc = JSON.parse(dlp.copilotLocations(["a@contoso.com", "b@contoso.com"]));
    assert.deepEqual(loc[0].Inclusions, [
      { Type: "User", Identity: "a@contoso.com" },
      { Type: "User", Identity: "b@contoso.com" },
    ]);
  });
});

test("copilotCondition", async (t) => {
  await t.test("maps SITs to a Name array (same shape as create_dlp_rule)", () => {
    assert.deepEqual(dlp.copilotCondition({ sits: ["Credit Card Number"] }), [{ Name: "Credit Card Number" }]);
  });

  await t.test("maps labels to a groups/labels condition", () => {
    const cond = dlp.copilotCondition({ labels: ["guid-1"] });
    assert.deepEqual(cond, [{ groups: [{ operator: "Or", labels: [{ name: "guid-1", type: "Sensitivity" }] }] }]);
  });

  await t.test("throws when both SITs and labels are supplied", () => {
    assert.throws(() => dlp.copilotCondition({ sits: ["x"], labels: ["y"] }), /cannot combine/);
  });

  await t.test("throws when no condition is supplied", () => {
    assert.throws(() => dlp.copilotCondition({}), /needs a condition/);
  });
});

test("sensitiveInformationTypeConditions", async (t) => {
  await t.test("keeps the existing string form backwards compatible", () => {
    assert.deepEqual(dlp.sensitiveInformationTypeConditions(["Credit Card Number"]), [
      { Name: "Credit Card Number" },
    ]);
  });

  await t.test("maps per-SIT count and confidence tuning", () => {
    assert.deepEqual(
      dlp.sensitiveInformationTypeConditions([
        { name: "Credit Card Number", min_count: 2, max_count: 9, confidence_level: "High" },
      ]),
      [{ operator: "And", groups: [{ operator: "Or", name: "Default", sensitivetypes: [{ Name: "Credit Card Number", minCount: 2, maxCount: 9, minConfidence: 85, maxConfidence: 100 }] }] }]
    );
  });

  await t.test("rejects a finite maximum below the minimum", () => {
    assert.throws(
      () => dlp.sensitiveInformationTypeConditions([{ name: "Credit Card Number", min_count: 5, max_count: 2 }]),
      /max_count must be -1.*at least min_count/
    );
  });
});

test("ruleWriteParams", () => {
  const result = dlp.ruleWriteParams({
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
  });

  assert.deepEqual(result, {
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

test("policy location exception parameter mapping", () => {
  assert.deepEqual(
    dlp.createPolicyLocationExceptionParams({
      sharepoint: ["https://contoso.sharepoint.com/sites/allowed"],
      endpoint: ["excluded@contoso.com"],
    }),
    {
      SharePointLocationException: ["https://contoso.sharepoint.com/sites/allowed"],
      EndpointDlpLocationException: ["excluded@contoso.com"],
    }
  );
  assert.deepEqual(
    dlp.updatePolicyLocationExceptionParams(
      { teams: ["add@contoso.com"] },
      { teams: ["remove@contoso.com"] }
    ),
    {
      AddTeamsLocationException: ["add@contoso.com"],
      RemoveTeamsLocationException: ["remove@contoso.com"],
    }
  );
});

test("formatPolicyList", async (t) => {
  await t.test("reports no policies when the list is empty", () => {
    assert.equal(dlp.formatPolicyList([]), "No DLP policies found.");
  });

  await t.test("pluralises correctly for a single policy", () => {
    const out = dlp.formatPolicyList([{ Name: "P1", Enabled: true, Mode: "Enable", Workload: "Exchange" }]);
    assert.match(out, /^1 DLP policy:\n/);
  });

  await t.test("shows disabled state when Enabled is false", () => {
    const out = dlp.formatPolicyList([{ Name: "P1", Enabled: false }]);
    assert.match(out, /disabled/);
  });

  await t.test("falls back to Mode or 'enabled' when Enabled is not false", () => {
    const out = dlp.formatPolicyList([{ Name: "P1", Mode: "TestWithNotifications" }]);
    assert.match(out, /TestWithNotifications/);
    const out2 = dlp.formatPolicyList([{ Name: "P2" }]);
    assert.match(out2, /enabled/);
  });

  await t.test("includes the GUID and never truncates an addressable policy name", () => {
    const name = "A deliberately long DLP policy name that must remain usable as an identity";
    const out = dlp.formatPolicyList([{ Name: name, Guid: "policy-guid" }]);
    assert.match(out, /policy-guid/);
    assert.match(out, new RegExp(name));
    assert.doesNotMatch(out, /\.\.\./);
  });
});

test("formatPolicyDetail", async (t) => {
  await t.test("reports not found for a nullish policy", () => {
    assert.equal(dlp.formatPolicyDetail(null), "DLP policy not found.");
    assert.equal(dlp.formatPolicyDetail(undefined), "DLP policy not found.");
  });

  await t.test("renders a heading and bullet fields", () => {
    const out = dlp.formatPolicyDetail({ Name: "P1", Mode: "Enable", Enabled: true, Workload: "Exchange" });
    assert.match(out, /^# DLP policy: P1/);
    assert.match(out, /- \*\*Mode:\*\* Enable/);
  });

  await t.test("summarises locations, detecting All and exclusions", () => {
    const out = dlp.formatPolicyDetail({
      Name: "P1",
      ExchangeLocation: ["All"],
      SharePointLocation: ["https://a", "https://b", "https://c"],
      SharePointLocationException: ["https://x"],
    });
    assert.match(out, /- \*\*Locations:\*\* Exchange \(All\), SharePoint \(3, excluded: 1\)/);
  });

  await t.test("omits the Locations line when no locations are present (e.g. a lean list object)", () => {
    const out = dlp.formatPolicyDetail({ Name: "P1", Mode: "Enable" });
    assert.doesNotMatch(out, /Locations:/);
  });
});

test("formatRuleList", async (t) => {
  await t.test("reports no rules when the list is empty", () => {
    assert.equal(dlp.formatRuleList([]), "No DLP rules found.");
  });

  await t.test("shows disabled/enabled state, priority, policy and block flag", () => {
    const out = dlp.formatRuleList([
      { Name: "R1", Disabled: true, Priority: 1, ParentPolicyName: "P1", BlockAccess: true },
      { Name: "R2", Priority: 2, Policy: "P2" },
    ]);
    assert.match(out, /2 DLP rule\(s\):/);
    assert.match(out, /disabled/);
    assert.match(out, /p1/);
    assert.match(out, /policy:P1/);
    assert.match(out, /BLOCK/);
    assert.match(out, /p2/);
    assert.match(out, /policy:P2/);
  });

  await t.test("surfaces sensitive information type names from ContentContainsSensitiveInformation", () => {
    const out = dlp.formatRuleList([
      {
        Name: "R1",
        Priority: 0,
        ContentContainsSensitiveInformation: [
          { groups: [{ sensitivetypes: [{ name: "Credit Card Number" }] }] },
        ],
      },
    ]);
    assert.match(out, /\[SIT: Credit Card Number\]/);
  });

  await t.test("shows p? when Priority is missing", () => {
    const out = dlp.formatRuleList([{ Name: "R1" }]);
    assert.match(out, /p\?/);
  });

  await t.test("includes the GUID and never truncates rule or parent-policy identities", () => {
    const rule = "Items containing 1-9 credit card numbers shared externally";
    const policy = "A deliberately long parent policy identity that must remain complete";
    const out = dlp.formatRuleList([{ Name: rule, Guid: "rule-guid", ParentPolicyName: policy }]);
    assert.match(out, /rule-guid/);
    assert.match(out, new RegExp(rule));
    assert.match(out, new RegExp(policy));
    assert.doesNotMatch(out, /\.\.\./);
  });
});

test("listSensitiveInformationTypes", async (t) => {
  await t.test("invokes Get-DlpSensitiveInformationType and returns everything for scope 'all'", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => [
      { Name: "Credit Card Number", Publisher: "Microsoft Corporation" },
      { Name: "Employee ID", Publisher: "Contoso" },
    ];
    const result = await dlp.listSensitiveInformationTypes("all");
    assert.equal(result.length, 2);
    assert.equal(invokeCalls.at(-1).cmdlet, "Get-DlpSensitiveInformationType");
  });

  await t.test("defaults to scope 'all' when not given", async () => {
    invokeImpl = async () => [{ Name: "Credit Card Number", Publisher: "Microsoft Corporation" }];
    const result = await dlp.listSensitiveInformationTypes();
    assert.equal(result.length, 1);
  });

  await t.test("filters to non-Microsoft Publisher values for scope 'custom'", async () => {
    invokeImpl = async () => [
      { Name: "Credit Card Number", Publisher: "Microsoft Corporation" },
      { Name: "Employee ID", Publisher: "Contoso" },
      { Name: "Badge Number", Publisher: "" },
    ];
    const result = await dlp.listSensitiveInformationTypes("custom");
    assert.deepEqual(
      result.map((s) => s.Name),
      ["Employee ID", "Badge Number"]
    );
  });

  await t.test("returns an empty array when there are no SITs", async () => {
    invokeImpl = async () => null;
    assert.deepEqual(await dlp.listSensitiveInformationTypes(), []);
  });

  await t.test("filters by name_contains (case-insensitive substring)", async () => {
    invokeImpl = async () => [
      { Name: "Credit Card Number", Publisher: "Microsoft Corporation" },
      { Name: "EU Debit Card Number", Publisher: "Microsoft Corporation" },
      { Name: "U.S. Social Security Number (SSN)", Publisher: "Microsoft Corporation" },
    ];
    const result = await dlp.listSensitiveInformationTypes("all", "card");
    assert.deepEqual(result.map((s) => s.Name), ["Credit Card Number", "EU Debit Card Number"]);
  });
});

test("formatSitList", async (t) => {
  await t.test("reports no SITs found for scope 'all' when the list is empty", () => {
    assert.equal(dlp.formatSitList([], "all"), "No sensitive information types found.");
  });

  await t.test("reports no custom SITs found for scope 'custom' when the list is empty", () => {
    assert.equal(dlp.formatSitList([], "custom"), "No custom sensitive information types found.");
  });

  await t.test("labels built-in vs custom based on Publisher", () => {
    const out = dlp.formatSitList([
      { Name: "Credit Card Number", Publisher: "Microsoft Corporation", Description: "Detects card numbers" },
      { Name: "Employee ID", Publisher: "Contoso", Description: "Detects employee IDs" },
    ]);
    assert.match(out, /2 sensitive information type\(s\):/);
    assert.match(out, /Credit Card Number.*built-in/);
    assert.match(out, /Employee ID.*custom/);
  });

  await t.test("includes the ID and never truncates an addressable SIT name", () => {
    const name = "A deliberately long sensitive information type name used by a rule";
    const out = dlp.formatSitList([{ Id: "sit-id", Name: name, Publisher: "Contoso" }]);
    assert.match(out, /sit-id/);
    assert.match(out, new RegExp(name));
    assert.doesNotMatch(out, /\.\.\./);
  });
});

test("formatWriteResult", async (t) => {
  await t.test("reports completion with no identity when the object is empty", () => {
    assert.equal(dlp.formatWriteResult("Create DLP policy", null), "Create DLP policy completed.");
  });

  await t.test("unwraps a single-element array result", () => {
    const out = dlp.formatWriteResult("Create DLP policy", [{ Name: "P1", Mode: "Enable" }]);
    assert.match(out, /^Create DLP policy succeeded: P1/);
    assert.match(out, /- \*\*Mode:\*\* Enable/);
  });

  await t.test("falls back to Identity or Guid when Name is missing", () => {
    const out = dlp.formatWriteResult("Set DLP rule", { Identity: "Rule1" });
    assert.match(out, /^Set DLP rule succeeded: Rule1/);
    const out2 = dlp.formatWriteResult("Set DLP rule", { Guid: "guid-1" });
    assert.match(out2, /^Set DLP rule succeeded: guid-1/);
  });
});
