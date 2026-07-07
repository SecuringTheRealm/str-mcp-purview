import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

// labels.js delegates all network access to graph.js's graphGet; mock that
// module so the data-access functions can be exercised deterministically.
const graphGetCalls = [];
let graphGetImpl = async () => ({ value: [] });

mock.module("../src/graph.js", {
  exports: {
    graphGet: async (path, params) => {
      graphGetCalls.push({ path, params });
      return graphGetImpl(path, params);
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
