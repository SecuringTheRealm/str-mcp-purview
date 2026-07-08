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
