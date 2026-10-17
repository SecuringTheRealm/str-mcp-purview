// Sensitivity-label configuration, backed primarily by Security & Compliance
// PowerShell. Graph remains only for per-user label policy settings.

import { graphGet, appOnly } from "./graph.js";
import { powershell } from "./powershell.js";
import { truncate, bulletFields, shortDate, asArray, formatWriteResult } from "./format.js";

// Re-exported so index.js can call labels.formatWriteResult for the label
// write tools (shared implementation lives in format.js).
export { formatWriteResult };

// App-only tokens have no /me/, so the Graph policy-settings read switches to
// the tenant-wide informationProtection path in that mode.
const BASE = appOnly ? "/security/informationProtection" : "/me/security/informationProtection";

// Label configuration reads and writes share the PowerShell plane. Graph is
// retained only for labelPolicySettings, which has no equivalent cmdlet.
const LABEL_WRITE_PROPS = ["Name", "DisplayName", "Guid", "ParentId", "Priority", "ContentType", "IsLabelGroup"];
const LABELPOLICY_WRITE_PROPS = ["Name", "Guid", "Labels", "Enabled", "Mode"];

// Read-back property sets make create/set/remove operations verifiable while
// keeping the PowerShell JSON payload bounded.
const LABELPOLICY_READ_PROPS = [
  ...LABELPOLICY_WRITE_PROPS,
  "Type", "ExchangeLocation", "ModernGroupLocation", "Settings",
  "Comment", "WhenCreated", "WhenChangedUTC",
];
const LABEL_READ_PROPS = [
  "Name", "DisplayName", "Guid", "Identity", "ContentType", "Tooltip", "Comment",
  "Priority", "ParentId", "IsLabelGroup", "IsActive", "Enabled", "Disabled", "Color", "LabelColor",
  "EncryptionEnabled", "EncryptionProtectionType", "EncryptionDoNotForward", "EncryptionEncryptOnly",
  "EncryptionOfflineAccessDays", "EncryptionRightsDefinitions",
  "ApplyContentMarkingHeaderEnabled", "ApplyContentMarkingHeaderText",
  "ApplyContentMarkingFooterEnabled", "ApplyContentMarkingFooterText",
  "ApplyWaterMarkingEnabled", "ApplyWaterMarkingText",
  "SiteAndGroupProtectionEnabled", "SiteAndGroupProtectionPrivacy",
  "SiteAndGroupProtectionAllowAccessToGuestUsers", "SiteExternalSharingControlType",
  "TeamsProtectionEnabled", "TeamsEndToEndEncryptionEnabled",
];

// ---- data access -----------------------------------------------------------

function identityKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** Normalise Get-Label output into a stable cross-plane public model. */
export function normalizeLabel(raw, knownLabels = []) {
  if (!raw) return undefined;
  const id = raw.Guid ?? raw.Identity ?? raw.Name;
  const sccName = raw.Name ?? raw.Identity;
  const displayName = raw.DisplayName ?? sccName;
  const parentId = raw.ParentId?.Guid ?? raw.ParentId?.Identity ?? raw.ParentId?.Name ?? raw.ParentId;
  const parentRaw = parentId
    ? knownLabels.find((candidate) =>
        [candidate.Guid, candidate.Identity, candidate.Name]
          .map(identityKey)
          .includes(identityKey(parentId))
      )
    : undefined;
  const isActive = typeof raw.IsActive === "boolean"
    ? raw.IsActive
    : typeof raw.Enabled === "boolean"
      ? raw.Enabled
      : typeof raw.Disabled === "boolean"
        ? !raw.Disabled
        : undefined;

  return {
    ...raw,
    id,
    scc_name: sccName,
    display_name: displayName,
    name: displayName,
    priority: raw.Priority,
    sensitivity: raw.Priority,
    is_label_group: typeof raw.IsLabelGroup === "boolean" ? raw.IsLabelGroup : undefined,
    isActive,
    color: raw.Color ?? raw.LabelColor,
    tooltip: raw.Tooltip,
    description: raw.Comment ?? raw.Tooltip,
    ...(parentId
      ? {
          parent: {
            id: parentRaw?.Guid ?? parentId,
            scc_name: parentRaw?.Name,
            name: parentRaw?.DisplayName ?? parentRaw?.Name,
          },
        }
      : {}),
  };
}

export async function listLabels() {
  const raw = asArray(await powershell.invoke("Get-Label", {}, LABEL_READ_PROPS));
  return raw.map((label) => normalizeLabel(label, raw));
}

export async function getLabel(identity) {
  const raw = asArray(await powershell.invoke("Get-Label", { Identity: identity }, LABEL_READ_PROPS))[0];
  return normalizeLabel(raw);
}

export async function getLabelPolicySettings() {
  const data = await graphGet(`${BASE}/labelPolicySettings`);
  return data.value ?? asArray(data);
}

/**
 * Client-side filter for the label list. Kept separate from listLabels (which
 * the label-catalog resource reuses unfiltered) and pure for testability.
 * @param {{ active?: boolean, parent?: string }} [f] active: state; parent: name/GUID of parent → its sub-labels.
 */
export function filterLabels(labels, f = {}) {
  return labels.filter((l) => {
    if (f.active != null && (l.isActive !== false) !== f.active) return false;
    if (f.parent) {
      const name = String(l.parent?.name ?? "").toLowerCase();
      const sccName = String(l.parent?.scc_name ?? "").toLowerCase();
      const wanted = f.parent.toLowerCase();
      if (name !== wanted && sccName !== wanted && identityKey(l.parent?.id) !== wanted) return false;
    }
    return true;
  });
}

// ---- data access (write: Security & Compliance PowerShell) -----------------

export async function createLabel(params) {
  return powershell.invoke("New-Label", params, LABEL_WRITE_PROPS);
}

export async function setLabel(params) {
  return powershell.invoke("Set-Label", params, LABEL_WRITE_PROPS);
}

export async function createLabelPolicy(params) {
  return powershell.invoke("New-LabelPolicy", params, LABELPOLICY_WRITE_PROPS);
}

export async function setLabelPolicy(params) {
  return powershell.invoke("Set-LabelPolicy", params, LABELPOLICY_WRITE_PROPS);
}

// Deletes: pass { Identity, Confirm: false } to avoid the interactive prompt.
export async function removeLabel(params) {
  return powershell.invoke("Remove-Label", params);
}

export async function removeLabelPolicy(params) {
  return powershell.invoke("Remove-LabelPolicy", params);
}

// ---- data access (read-back: Security & Compliance PowerShell) -------------

export async function listLabelPolicies() {
  return asArray(await powershell.invoke("Get-LabelPolicy", {}, LABELPOLICY_READ_PROPS));
}

export async function getLabelPolicy(identity) {
  return asArray(await powershell.invoke("Get-LabelPolicy", { Identity: identity }, LABELPOLICY_READ_PROPS))[0];
}

/** Backwards-compatible helper; the authoritative read includes protection. */
export async function getLabelProtectionSettings(identity) {
  return getLabel(identity);
}

/**
 * Map the structured, category-grouped tool input into the flat PascalCase
 * parameters that New-/Set-Label expect. Shared by create and modify; only
 * supplied fields are emitted. Kept pure so it is unit-testable without pwsh.
 */
export function labelSettingsParams(args = {}) {
  const p = {};
  if (args.display_name != null) p.DisplayName = args.display_name;
  if (args.tooltip != null) p.Tooltip = args.tooltip;
  if (args.comment != null) p.Comment = args.comment;
  if (args.color != null) p.AdvancedSettings = { color: args.color };

  const e = args.encryption;
  if (e) {
    if (e.enabled != null) p.EncryptionEnabled = e.enabled;
    if (e.protection_type) p.EncryptionProtectionType = e.protection_type;
    if (e.do_not_forward != null) p.EncryptionDoNotForward = e.do_not_forward;
    if (e.encrypt_only != null) p.EncryptionEncryptOnly = e.encrypt_only;
    if (e.offline_access_days != null) p.EncryptionOfflineAccessDays = e.offline_access_days;
    if (e.rights_definitions?.length) {
      p.EncryptionRightsDefinitions = e.rights_definitions.map((r) => ({
        Identity: r.identity,
        Rights: Array.isArray(r.rights) ? r.rights.join(",") : r.rights,
      }));
    }
  }

  const cm = args.content_marking;
  if (cm) {
    const h = cm.header;
    if (h) {
      if (h.enabled != null) p.ApplyContentMarkingHeaderEnabled = h.enabled;
      if (h.text != null) p.ApplyContentMarkingHeaderText = h.text;
      if (h.font_color) p.ApplyContentMarkingHeaderFontColor = h.font_color;
      if (h.font_size != null) p.ApplyContentMarkingHeaderFontSize = h.font_size;
      if (h.alignment) p.ApplyContentMarkingHeaderAlignment = h.alignment;
    }
    const f = cm.footer;
    if (f) {
      if (f.enabled != null) p.ApplyContentMarkingFooterEnabled = f.enabled;
      if (f.text != null) p.ApplyContentMarkingFooterText = f.text;
      if (f.font_color) p.ApplyContentMarkingFooterFontColor = f.font_color;
      if (f.font_size != null) p.ApplyContentMarkingFooterFontSize = f.font_size;
      if (f.alignment) p.ApplyContentMarkingFooterAlignment = f.alignment;
    }
    const w = cm.watermark;
    if (w) {
      if (w.enabled != null) p.ApplyWaterMarkingEnabled = w.enabled;
      if (w.text != null) p.ApplyWaterMarkingText = w.text;
      if (w.font_color) p.ApplyWaterMarkingFontColor = w.font_color;
      if (w.font_size != null) p.ApplyWaterMarkingFontSize = w.font_size;
      if (w.layout) p.ApplyWaterMarkingLayout = w.layout;
    }
  }

  const sg = args.site_and_group_protection;
  if (sg) {
    if (sg.enabled != null) p.SiteAndGroupProtectionEnabled = sg.enabled;
    if (sg.privacy) p.SiteAndGroupProtectionPrivacy = sg.privacy;
    if (sg.allow_guest_access != null) p.SiteAndGroupProtectionAllowAccessToGuestUsers = sg.allow_guest_access;
    if (sg.external_sharing_control) p.SiteExternalSharingControlType = sg.external_sharing_control;
    if (sg.access_level) p.SiteAndGroupProtectionLevel = sg.access_level;
  }

  const t = args.teams_protection;
  if (t) {
    if (t.enabled != null) p.TeamsProtectionEnabled = t.enabled;
    if (t.allow_meeting_chat) p.TeamsAllowMeetingChat = t.allow_meeting_chat;
    if (t.allowed_presenters) p.TeamsAllowedPresenters = t.allowed_presenters;
    if (t.end_to_end_encryption != null) p.TeamsEndToEndEncryptionEnabled = t.end_to_end_encryption;
    if (t.prevent_copy != null) p.TeamsCopyRestrictionEnforced = t.prevent_copy;
  }

  return p;
}

// ---- formatters ------------------------------------------------------------

function labelLine(label) {
  const active = label.isActive === false ? "inactive" : label.isActive === true ? "active" : "state?";
  const parent = label.parent?.name ? ` (parent: ${label.parent.name})` : "";
  const priority = label.priority != null ? `p${label.priority}` : "p?";
  return `${label.id ?? "-"}  ${label.scc_name ?? "-"}  ${priority}  ${active}  ${label.display_name ?? label.name ?? "(unknown)"}${label.is_label_group === true ? " (label group)" : ""}${parent}  — ${truncate(label.description, 60)}`;
}

export function formatLabelList(labels) {
  if (!labels.length) return "No sensitivity labels available to this account.";
  const lines = labels.map(labelLine);
  return `${labels.length} sensitivity label(s):\n${lines.join("\n")}`;
}

export function formatLabelDetail(label) {
  if (!label) return "Sensitivity label not found.";
  const lines = [
    `# ${label.display_name ?? label.name ?? label.id}`,
    bulletFields(label, [
      ["id", "GUID"],
      ["scc_name", "SCC name"],
      ["display_name", "Display name"],
      ["priority", "Priority"],
      ["is_label_group", "Label group"],
      ["isActive", "Active"],
      ["color", "Color"],
      ["tooltip", "Tooltip"],
      ["description", "Description"],
    ]),
  ];
  if (label.parent?.name || label.parent?.id) {
    lines.push("", `**Parent label:** ${label.parent.name ?? label.parent.id}`);
  }
  lines.push("", formatLabelProtectionSettings(label));
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

function labelPolicyLine(p) {
  const labelCount = asArray(p.Labels).length;
  const state = p.Enabled === false ? "disabled" : (p.Mode ?? "enabled");
  return `${p.Guid ?? "-"}  ${p.Name ?? "(unknown)"}  ${state}  ${labelCount} label(s)  ${shortDate(p.WhenCreated)}`;
}

export function formatLabelPolicyList(policies) {
  if (!policies.length) return "No label publishing policies found.";
  return `${policies.length} label publishing polic${policies.length === 1 ? "y" : "ies"}:\n${policies.map(labelPolicyLine).join("\n")}`;
}

export function formatLabelPolicyDetail(p) {
  if (!p) return "Label policy not found.";
  const lines = [
    `# Label policy: ${p.Name}`,
    bulletFields({ ...p,
      ExchangeLocation: formatPolicyLocations(p.ExchangeLocation),
      ModernGroupLocation: formatPolicyLocations(p.ModernGroupLocation),
    }, [
      ["Guid", "GUID"],
      ["Enabled", "Enabled"],
      ["Mode", "Mode"],
      ["Type", "Type"],
      ["Labels", "Published labels"],
      ["ExchangeLocation", "Exchange locations"],
      ["ModernGroupLocation", "Microsoft 365 Groups"],
      ["Comment", "Comment"],
      ["WhenCreated", "Created"],
      ["WhenChangedUTC", "Last changed (UTC)"],
    ]),
  ];
  const settings = asArray(p.Settings).filter(Boolean);
  if (settings.length) lines.push(`- **Settings:** ${settings.map((s) => truncate(String(s), 80)).join("; ")}`);
  return lines.filter(Boolean).join("\n");
}

function formatPolicyLocations(value) {
  return asArray(value).filter((entry) => entry != null).map((entry) => {
    if (typeof entry !== "object") return String(entry);
    const scalar = (...keys) => keys.map((key) => entry[key]).find((v) => typeof v === "string" && v.trim());
    const name = scalar("DisplayName", "Name", "displayName", "name");
    const identity = scalar("PrimarySmtpAddress", "SmtpAddress", "EmailAddress", "Identity", "Guid", "Id", "primarySmtpAddress", "emailAddress", "identity", "id");
    return name && identity && name !== identity ? `${name} (${identity})` : name ?? identity ?? "Unknown location (no name or identity returned)";
  });
}

export function formatLabelProtectionSettings(label) {
  if (!label) return "Label not found on the policy plane.";
  const body = bulletFields(label, [
    ["ContentType", "Scopes"],
    ["Priority", "Priority"],
    ["ParentId", "Parent"],
    ["EncryptionEnabled", "Encryption"],
    ["EncryptionProtectionType", "Encryption type"],
    ["EncryptionDoNotForward", "Do Not Forward"],
    ["EncryptionEncryptOnly", "Encrypt-Only"],
    ["EncryptionOfflineAccessDays", "Offline access (days)"],
    ["ApplyContentMarkingHeaderEnabled", "Header marking"],
    ["ApplyContentMarkingHeaderText", "Header text"],
    ["ApplyContentMarkingFooterEnabled", "Footer marking"],
    ["ApplyContentMarkingFooterText", "Footer text"],
    ["ApplyWaterMarkingEnabled", "Watermark"],
    ["ApplyWaterMarkingText", "Watermark text"],
    ["SiteAndGroupProtectionEnabled", "Container protection"],
    ["SiteAndGroupProtectionPrivacy", "Container privacy"],
    ["SiteAndGroupProtectionAllowAccessToGuestUsers", "Guest access"],
    ["SiteExternalSharingControlType", "External sharing"],
    ["TeamsProtectionEnabled", "Teams meeting protection"],
    ["TeamsEndToEndEncryptionEnabled", "Teams E2E encryption"],
  ]);
  const rights = asArray(label.EncryptionRightsDefinitions);
  const lines = ["## Protection settings", body || "- No protection configured."];
  if (rights.length) {
    lines.push(`- **Rights definitions:** ${rights.map((r) => `${r?.Identity ?? r}`).join(", ")}`);
  }
  return lines.join("\n");
}

// Re-exported so index.js can reference the shared helper without another import.
export { shortDate };
