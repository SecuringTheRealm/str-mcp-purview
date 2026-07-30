import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// labels.js delegates all network access to graph.js's graphGet; mock that
// module so the data-access functions can be exercised deterministically.
const graphGetCalls = [];
let graphGetImpl = async () => ({ value: [] });

mock.module("../src/graph.js", {
  namedExports: {
    graphGet: async (path, params) => {
      graphGetCalls.push({ path, params });
      return graphGetImpl(path, params);
    },
    // listLabels uses the paginating variant; collapse it onto the same stub.
    graphGetAll: async (path, params) => {
      graphGetCalls.push({ path, params });
      return (await graphGetImpl(path, params)).value ?? [];
    },
    appOnly: false,
  },
});

// Label writes go through the PowerShell bridge; mock it too.
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

const labels = await import("../src/labels.js");

test("listLabels", async (t) => {
  await t.test("returns the value array from Graph", async () => {
    graphGetImpl = async () => ({ value: [{ id: "1" }, { id: "2" }] });
    const result = await labels.listLabels();
    assert.deepEqual(result, [{ id: "1" }, { id: "2" }]);
  });

  await t.test("returns an empty array when Graph returns no value", async () => {
    graphGetImpl = async () => ({});
    assert.deepEqual(await labels.listLabels(), []);
  });
});

test("getLabel", async (t) => {
  await t.test("requests the label by ID, URL-encoded", async () => {
    graphGetCalls.length = 0;
    graphGetImpl = async () => ({ id: "abc/def" });
    await labels.getLabel("abc/def");
    assert.equal(
      graphGetCalls.at(-1).path,
      "/me/security/informationProtection/sensitivityLabels/abc%2Fdef"
    );
  });
});

test("getLabelPolicySettings", async (t) => {
  await t.test("returns the value array when present", async () => {
    graphGetImpl = async () => ({ value: [{ id: "p1" }] });
    assert.deepEqual(await labels.getLabelPolicySettings(), [{ id: "p1" }]);
  });

  await t.test("wraps a single object result via asArray when there is no value key", async () => {
    graphGetImpl = async () => ({ id: "p1" });
    assert.deepEqual(await labels.getLabelPolicySettings(), [{ id: "p1" }]);
  });
});

test("label write functions invoke the right cmdlet", async (t) => {
  await t.test("createLabel → New-Label", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => ({ Name: "L1" });
    await labels.createLabel({ Name: "L1", DisplayName: "L1", Tooltip: "t" });
    assert.equal(invokeCalls.at(-1).cmdlet, "New-Label");
  });

  await t.test("setLabel → Set-Label", async () => {
    invokeImpl = async () => ({ Name: "L1" });
    await labels.setLabel({ Identity: "L1", Tooltip: "t2" });
    assert.equal(invokeCalls.at(-1).cmdlet, "Set-Label");
  });

  await t.test("createLabelPolicy → New-LabelPolicy", async () => {
    invokeImpl = async () => ({ Name: "P1" });
    await labels.createLabelPolicy({ Name: "P1", Labels: ["L1"] });
    assert.equal(invokeCalls.at(-1).cmdlet, "New-LabelPolicy");
  });

  await t.test("setLabelPolicy → Set-LabelPolicy", async () => {
    invokeImpl = async () => ({ Name: "P1" });
    await labels.setLabelPolicy({ Identity: "P1", AddLabels: ["L2"] });
    assert.equal(invokeCalls.at(-1).cmdlet, "Set-LabelPolicy");
  });

  await t.test("removeLabel → Remove-Label", async () => {
    invokeImpl = async () => null;
    await labels.removeLabel({ Identity: "L1", Confirm: false });
    assert.equal(invokeCalls.at(-1).cmdlet, "Remove-Label");
    assert.deepEqual(invokeCalls.at(-1).params, { Identity: "L1", Confirm: false });
  });

  await t.test("removeLabelPolicy → Remove-LabelPolicy", async () => {
    invokeImpl = async () => null;
    await labels.removeLabelPolicy({ Identity: "P1", Confirm: false });
    assert.equal(invokeCalls.at(-1).cmdlet, "Remove-LabelPolicy");
  });
});

test("labelSettingsParams", async (t) => {
  await t.test("maps the mandatory fields", () => {
    const p = labels.labelSettingsParams({ display_name: "Conf", tooltip: "Sensitive", comment: "c" });
    assert.deepEqual(p, { DisplayName: "Conf", Tooltip: "Sensitive", Comment: "c" });
  });

  await t.test("flattens encryption, including rights definitions", () => {
    const p = labels.labelSettingsParams({
      encryption: { enabled: true, protection_type: "Template", rights_definitions: [{ identity: "a@x", rights: ["VIEW", "EDIT"] }] },
    });
    assert.equal(p.EncryptionEnabled, true);
    assert.equal(p.EncryptionProtectionType, "Template");
    assert.deepEqual(p.EncryptionRightsDefinitions, [{ Identity: "a@x", Rights: "VIEW,EDIT" }]);
  });

  await t.test("flattens content marking header/footer/watermark", () => {
    const p = labels.labelSettingsParams({
      content_marking: { header: { enabled: true, text: "TOP SECRET" }, watermark: { enabled: true, layout: "Diagonal" } },
    });
    assert.equal(p.ApplyContentMarkingHeaderEnabled, true);
    assert.equal(p.ApplyContentMarkingHeaderText, "TOP SECRET");
    assert.equal(p.ApplyWaterMarkingEnabled, true);
    assert.equal(p.ApplyWaterMarkingLayout, "Diagonal");
  });

  await t.test("flattens container and Teams protection", () => {
    const p = labels.labelSettingsParams({
      site_and_group_protection: { enabled: true, privacy: "Private" },
      teams_protection: { enabled: true, end_to_end_encryption: true },
    });
    assert.equal(p.SiteAndGroupProtectionEnabled, true);
    assert.equal(p.SiteAndGroupProtectionPrivacy, "Private");
    assert.equal(p.TeamsProtectionEnabled, true);
    assert.equal(p.TeamsEndToEndEncryptionEnabled, true);
  });

  await t.test("emits nothing for empty input", () => {
    assert.deepEqual(labels.labelSettingsParams({}), {});
  });
});

test("filterLabels", async (t) => {
  const list = [
    { id: "L1", name: "Confidential", isActive: true },
    { id: "L2", name: "Old", isActive: false },
    { id: "L3", name: "Conf-Sub", isActive: true, parent: { name: "Confidential", id: "L1" } },
  ];
  await t.test("returns all when no filter", () => {
    assert.equal(labels.filterLabels(list).length, 3);
  });
  await t.test("active:true drops inactive labels", () => {
    assert.deepEqual(labels.filterLabels(list, { active: true }).map((l) => l.id), ["L1", "L3"]);
  });
  await t.test("active:false keeps only inactive labels", () => {
    assert.deepEqual(labels.filterLabels(list, { active: false }).map((l) => l.id), ["L2"]);
  });
  await t.test("parent filters to sub-labels of the given parent (by name or id)", () => {
    assert.deepEqual(labels.filterLabels(list, { parent: "Confidential" }).map((l) => l.id), ["L3"]);
    assert.deepEqual(labels.filterLabels(list, { parent: "L1" }).map((l) => l.id), ["L3"]);
  });
});

test("formatLabelList", async (t) => {
  await t.test("reports no labels when the list is empty", () => {
    assert.equal(labels.formatLabelList([]), "No sensitivity labels available to this account.");
  });

  await t.test("renders one compact line per label with count header", () => {
    const out = labels.formatLabelList([
      { id: "L1", name: "Confidential", sensitivity: 2, isActive: true, description: "Sensitive data" },
      {
        id: "L2",
        name: "Public",
        sensitivity: 0,
        isActive: false,
        parent: { name: "Top" },
        description: "Not sensitive",
      },
    ]);
    assert.match(out, /^2 sensitivity label\(s\):\n/);
    assert.match(out, /L1 {2}s2 {2}active {4}Confidential {2}— Sensitive data/);
    assert.match(out, /L2 {2}s0 {2}inactive {2}Public \(parent: Top\) {2}— Not sensitive/);
  });

  await t.test("defaults sensitivity to s? when missing", () => {
    const out = labels.formatLabelList([{ id: "L3", name: "Unknown" }]);
    assert.match(out, /L3 {2}s\? {2}active/);
  });
});

test("formatLabelDetail", async (t) => {
  await t.test("renders a heading and bullet fields", () => {
    const out = labels.formatLabelDetail({
      id: "L1",
      name: "Confidential",
      sensitivity: 2,
      isActive: true,
      color: "#ff0000",
      tooltip: "Handle with care",
      description: "Sensitive data",
    });
    assert.match(out, /^# Confidential/);
    assert.match(out, /- \*\*ID:\*\* L1/);
    assert.match(out, /- \*\*Color:\*\* #ff0000/);
  });

  await t.test("falls back to the ID as heading when name is missing", () => {
    const out = labels.formatLabelDetail({ id: "L9" });
    assert.match(out, /^# L9/);
  });

  await t.test("appends the parent label line when present", () => {
    const out = labels.formatLabelDetail({ id: "L1", name: "Child", parent: { name: "Parent", id: "P1" } });
    assert.match(out, /\*\*Parent label:\*\* Parent/);
  });

  await t.test("uses the parent ID when the parent has no name", () => {
    const out = labels.formatLabelDetail({ id: "L1", name: "Child", parent: { id: "P1" } });
    assert.match(out, /\*\*Parent label:\*\* P1/);
  });
});

test("formatPolicySettings", async (t) => {
  await t.test("reports no settings for an empty list", () => {
    assert.equal(labels.formatPolicySettings([]), "No label policy settings returned for this account.");
  });

  await t.test("renders a section per settings object", () => {
    const out = labels.formatPolicySettings([
      { id: "s1", isMandatory: true, defaultLabelId: "L1" },
    ]);
    assert.match(out, /^# Label policy settings/);
    assert.match(out, /- \*\*ID:\*\* s1/);
    assert.match(out, /- \*\*Labeling mandatory:\*\* true/);
  });

  await t.test("normalises a single non-array settings object via asArray", () => {
    const out = labels.formatPolicySettings({ id: "s1" });
    assert.match(out, /- \*\*ID:\*\* s1/);
  });
});

test("label policy read-back", async (t) => {
  await t.test("listLabelPolicies invokes Get-LabelPolicy and normalises to an array", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => ({ Name: "Global", Labels: ["Public", "Internal"], Mode: "Enable" });
    const result = await labels.listLabelPolicies();
    assert.equal(invokeCalls.at(-1).cmdlet, "Get-LabelPolicy");
    assert.deepEqual(result.map((p) => p.Name), ["Global"]);
  });

  await t.test("getLabelPolicy passes the identity through", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => [{ Name: "Global" }];
    await labels.getLabelPolicy("Global");
    assert.deepEqual(invokeCalls.at(-1).params, { Identity: "Global" });
  });

  await t.test("formatLabelPolicyList renders one line per policy with label count", () => {
    const out = labels.formatLabelPolicyList([
      { Name: "Global", Enabled: true, Mode: "Enable", Labels: ["A", "B"], WhenCreated: "2026-07-01T00:00:00Z" },
    ]);
    assert.match(out, /1 label publishing policy:/);
    assert.match(out, /Global/);
    assert.match(out, /2 label\(s\)/);
  });

  await t.test("formatLabelPolicyDetail renders labels, locations, and settings", () => {
    const out = labels.formatLabelPolicyDetail({
      Name: "Global",
      Guid: "g1",
      Labels: ["Public", "Internal"],
      ExchangeLocation: ["All"],
      Settings: ["[mandatory, true]"],
    });
    assert.match(out, /^# Label policy: Global/);
    assert.match(out, /\*\*Published labels:\*\* Public, Internal/);
    assert.match(out, /\*\*Settings:\*\* \[mandatory, true\]/);
  });

  await t.test("formatLabelPolicyDetail handles a missing policy", () => {
    assert.equal(labels.formatLabelPolicyDetail(undefined), "Label policy not found.");
  });
});

test("label protection settings read-back", async (t) => {
  await t.test("getLabelProtectionSettings invokes Get-Label with the identity", async () => {
    invokeCalls.length = 0;
    invokeImpl = async () => [{ Name: "Secret", EncryptionEnabled: true }];
    const result = await labels.getLabelProtectionSettings("Secret");
    assert.equal(invokeCalls.at(-1).cmdlet, "Get-Label");
    assert.deepEqual(invokeCalls.at(-1).params, { Identity: "Secret" });
    assert.equal(result.EncryptionEnabled, true);
  });

  await t.test("formatLabelProtectionSettings renders configured protection", () => {
    const out = labels.formatLabelProtectionSettings({
      EncryptionEnabled: true,
      EncryptionProtectionType: "Template",
      ApplyWaterMarkingEnabled: true,
      EncryptionRightsDefinitions: [{ Identity: "staff@contoso.com" }],
    });
    assert.match(out, /^## Protection settings/);
    assert.match(out, /\*\*Encryption:\*\* true/);
    assert.match(out, /\*\*Rights definitions:\*\* staff@contoso\.com/);
  });

  await t.test("formatLabelProtectionSettings reports an unprotected label", () => {
    assert.match(labels.formatLabelProtectionSettings({}), /No protection configured/);
  });
});
