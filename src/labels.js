// Sensitivity-label tools, backed by Microsoft Graph (beta) Information
// Protection endpoints, acting as the signed-in admin.

import { graphGet } from "./graph.js";
import { truncate, bulletFields, shortDate, asArray } from "./format.js";

const BASE = "/me/security/informationProtection";

// ---- data access -----------------------------------------------------------

export async function listLabels() {
  const data = await graphGet(`${BASE}/sensitivityLabels`);
  return data.value ?? [];
}

export async function getLabel(labelId) {
  return graphGet(`${BASE}/sensitivityLabels/${encodeURIComponent(labelId)}`);
}

export async function getLabelPolicySettings() {
  const data = await graphGet(`${BASE}/labelPolicySettings`);
  return data.value ?? asArray(data);
}

// ---- formatters ------------------------------------------------------------

function labelLine(label) {
  const active = label.isActive === false ? "inactive" : "active";
  const parent = label.parent?.name ? ` (parent: ${label.parent.name})` : "";
  const sensitivity = label.sensitivity != null ? `s${label.sensitivity}` : "s?";
  return `${label.id}  ${sensitivity}  ${active.padEnd(8)}  ${truncate(label.name, 40)}${parent}  — ${truncate(label.description, 60)}`;
}

export function formatLabelList(labels) {
  if (!labels.length) return "No sensitivity labels available to this account.";
  const lines = labels.map(labelLine);
  return `${labels.length} sensitivity label(s):\n${lines.join("\n")}`;
}

export function formatLabelDetail(label) {
  const lines = [
    `# ${label.name ?? label.id}`,
    bulletFields(label, [
      ["id", "ID"],
      ["sensitivity", "Sensitivity (0 = least sensitive)"],
      ["isActive", "Active"],
      ["color", "Color"],
      ["tooltip", "Tooltip"],
      ["description", "Description"],
    ]),
  ];
  if (label.parent?.name || label.parent?.id) {
    lines.push("", `**Parent label:** ${label.parent.name ?? label.parent.id}`);
  }
  return lines.filter(Boolean).join("\n");
}

export function formatPolicySettings(settings) {
  const arr = asArray(settings);
  if (!arr.length) return "No label policy settings returned for this account.";
  const lines = ["# Label policy settings"];
  for (const s of arr) {
    lines.push(
      "",
      bulletFields(s, [
        ["id", "ID"],
        ["moreInfoUrl", "More info URL"],
        ["isMandatory", "Labeling mandatory"],
        ["isDowngradeJustificationRequired", "Downgrade justification required"],
        ["defaultLabelId", "Default label ID"],
      ])
    );
  }
  return lines.filter(Boolean).join("\n");
}

// Re-exported so index.js can reference the shared helper without another import.
export { shortDate };
