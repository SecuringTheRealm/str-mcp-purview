import { test, mock } from "node:test";
import assert from "node:assert/strict";

// labels.js imports the Graph client and the PowerShell bridge; mock both so
// nothing real is called.
mock.module("../src/graph.js", {
  namedExports: { graphGet: async () => ({ value: [] }), appOnly: false },
});

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

test("listLabels returns stable SCC, GUID and display identities with the parent resolved", async () => {
  invokeImpl = async () => [
    { Name: "internal-parent", DisplayName: "Parent", Guid: "1", Priority: 0, Enabled: true },
    { Name: "internal-child", DisplayName: "Child", Guid: "2", ParentId: "1", Priority: 1 },
  ];
  const [parent, child] = await labels.listLabels();
  assert.deepEqual([parent.id, parent.scc_name, parent.display_name, parent.isActive], ["1", "internal-parent", "Parent", true]);
  assert.deepEqual(child.parent, { id: "1", scc_name: "internal-parent", name: "Parent" });

  invokeImpl = async () => null;
  assert.deepEqual(await labels.listLabels(), []);
});

test("label group status survives PowerShell reads and is only set when reported", async () => {
  invokeImpl = async () => ({ Name: "Group", DisplayName: "Confidential", Guid: "group-guid", IsLabelGroup: true });
  const group = await labels.getLabel("group-guid");
  assert.equal(group.is_label_group, true);
  assert.ok(invokeCalls.at(-1).selectProps.includes("IsLabelGroup"));
  assert.match(labels.formatLabelList([group]), /Confidential \(label group\)/);
  assert.equal(labels.normalizeLabel({ Name: "classic" }).is_label_group, undefined);
  assert.equal(labels.normalizeLabel({ Name: "label", IsLabelGroup: false }).is_label_group, false);
});

test("labelSettingsParams maps tool arguments to Purview label parameters", () => {
  const cases = [
    [{ color: "#123ABC" }, { AdvancedSettings: { color: "#123ABC" } }],
    [{ display_name: "Conf", tooltip: "Sensitive", comment: "c" }, { DisplayName: "Conf", Tooltip: "Sensitive", Comment: "c" }],
    [
      { encryption: { enabled: true, protection_type: "Template", rights_definitions: [{ identity: "a@x", rights: ["VIEW", "EDIT"] }] } },
      { EncryptionEnabled: true, EncryptionProtectionType: "Template", EncryptionRightsDefinitions: [{ Identity: "a@x", Rights: "VIEW,EDIT" }] },
    ],
    [
      { content_marking: { header: { enabled: true, text: "TOP SECRET" }, watermark: { enabled: true, layout: "Diagonal" } } },
      { ApplyContentMarkingHeaderEnabled: true, ApplyContentMarkingHeaderText: "TOP SECRET", ApplyWaterMarkingEnabled: true, ApplyWaterMarkingLayout: "Diagonal" },
    ],
    [
      { site_and_group_protection: { enabled: true, privacy: "Private" }, teams_protection: { enabled: true, end_to_end_encryption: true } },
      { SiteAndGroupProtectionEnabled: true, SiteAndGroupProtectionPrivacy: "Private", TeamsProtectionEnabled: true, TeamsEndToEndEncryptionEnabled: true },
    ],
  ];
  for (const [input, expected] of cases) {
    const out = labels.labelSettingsParams(input);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(out[key], value, key);
  }
  assert.deepEqual(labels.labelSettingsParams({}), {});
});

test("filterLabels filters by active state and by parent name, SCC name or id", () => {
  const list = [
    { id: "L1", name: "Confidential", isActive: true },
    { id: "L2", name: "Old", isActive: false },
    { id: "L3", name: "Conf-Sub", isActive: true, parent: { name: "Confidential", scc_name: "internal-conf", id: "L1" } },
  ];
  const ids = (f) => labels.filterLabels(list, f).map((l) => l.id);
  assert.deepEqual(ids(), ["L1", "L2", "L3"]);
  assert.deepEqual(ids({ active: true }), ["L1", "L3"]);
  assert.deepEqual(ids({ active: false }), ["L2"]);
  for (const parent of ["Confidential", "internal-conf", "L1"]) assert.deepEqual(ids({ parent }), ["L3"]);
});

test("label policy detail renders object and string locations without [object Object]", () => {
  const out = labels.formatLabelPolicyDetail({
    Name: "Scoped",
    ExchangeLocation: ["All", { DisplayName: "Finance", PrimarySmtpAddress: "finance@contoso.com" }, { Identity: "admin@contoso.com" }, null, {}],
    ModernGroupLocation: { Name: "Engineering", Identity: "engineering@contoso.com" },
  });
  assert.match(out, /Exchange locations:\*\* All, Finance \(finance@contoso.com\), admin@contoso.com, Unknown location/);
  assert.match(out, /Microsoft 365 Groups:\*\* Engineering \(engineering@contoso.com\)/);
  assert.doesNotMatch(out, /\[object Object\]/);
});
