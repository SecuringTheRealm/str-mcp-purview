// DLP policy/rule tools, backed by the Security & Compliance PowerShell bridge.
// Reads use Get-DlpCompliance*, writes use New-/Set-DlpCompliance*.

import { powershell } from "./powershell.js";
import { truncate, shortDate, asArray, bulletFields, formatWriteResult } from "./format.js";

// Re-exported so index.js can keep calling dlp.formatWriteResult; the shared
// implementation lives in format.js (also used by the label write tools).
export { formatWriteResult };

// Trimmed property sets keep ConvertTo-Json output small and free of the deep,
// occasionally self-referential graph that Exchange policy objects carry.
const POLICY_PROPS = [
  "Name", "Guid", "Mode", "Enabled", "Workload", "Type",
  "CreatedBy", "WhenCreated", "WhenChangedUTC", "Comment",
];
const RULE_PROPS = [
  "Name", "Guid", "Policy", "ParentPolicyName", "Disabled", "Mode",
  "Priority", "BlockAccess", "BlockAccessScope", "NotifyUser",
  "GenerateAlert", "ReportSeverityLevel", "ContentContainsSensitiveInformation",
];
const SIT_PROPS = ["Name", "Id", "Publisher", "Description"];

// Detail reads (get_dlp_policy / get_dlp_rule) select a wider set than the lean
// list reads, so scope/exception hygiene can be analysed on demand without
// bloating list output. Formatters summarise these rather than dumping them.
const POLICY_LOCATION_FIELDS = [
  ["ExchangeLocation", "Exchange", "ExchangeLocationException"],
  ["SharePointLocation", "SharePoint", "SharePointLocationException"],
  ["OneDriveLocation", "OneDrive", "OneDriveLocationException"],
  ["TeamsLocation", "Teams", "TeamsLocationException"],
  ["EndpointDlpLocation", "Endpoint", "EndpointDlpLocationException"],
  ["OnPremisesScannerDlpLocation", "On-prem scanner", null],
  ["PowerBIDlpLocation", "Power BI", null],
  ["ThirdPartyAppDlpLocation", "Third-party apps", null],
];
const RULE_EXCEPTION_FIELDS = [
  ["ExceptIfContentContainsSensitiveInformation", "sensitive-info"],
  ["ExceptIfContentPropertyContainsWords", "content-property"],
  ["ExceptIfDocumentNameMatchesWords", "doc-name"],
  ["ExceptIfDocumentNameMatchesPatterns", "doc-name-pattern"],
  ["ExceptIfDocumentMatchesPatterns", "doc-content-pattern"],
  ["ExceptIfContentExtensionMatchesWords", "file-extension"],
  ["ExceptIfFrom", "sender"],
  ["ExceptIfFromMemberOf", "sender-group"],
  ["ExceptIfSentTo", "recipient"],
  ["ExceptIfRecipientDomainIs", "recipient-domain"],
  ["ExceptIfSenderDomainIs", "sender-domain"],
];

const POLICY_DETAIL_PROPS = [...POLICY_PROPS, ...POLICY_LOCATION_FIELDS.flatMap(([f, , e]) => (e ? [f, e] : [f]))];
const RULE_DETAIL_PROPS = [
  ...RULE_PROPS,
  "StopPolicyProcessing", "RestrictAccess", "EncryptRMSTemplate", "Quarantine",
  "GenerateIncidentReport", "NotifyPolicyTipCustomText",
  ...RULE_EXCEPTION_FIELDS.map(([f]) => f),
];

// Per Microsoft docs, custom SITs always report a Publisher other than this
// value: https://learn.microsoft.com/purview/sit-create-a-custom-sensitive-information-type-in-scc-powershell
const BUILTIN_SIT_PUBLISHER = "Microsoft Corporation";

// ---- data access -----------------------------------------------------------

export async function listPolicies() {
  return asArray(await powershell.invoke("Get-DlpCompliancePolicy", {}, POLICY_PROPS));
}

export async function getPolicy(identity) {
  return asArray(await powershell.invoke("Get-DlpCompliancePolicy", { Identity: identity }, POLICY_DETAIL_PROPS))[0];
}

export async function listRules(policy) {
  const params = policy ? { Policy: policy } : {};
  return asArray(await powershell.invoke("Get-DlpComplianceRule", params, RULE_PROPS));
}

export async function getRule(identity) {
  return asArray(await powershell.invoke("Get-DlpComplianceRule", { Identity: identity }, RULE_DETAIL_PROPS))[0];
}

// ---- client-side list filters ----------------------------------------------
// Applied after fetch to trim output. Kept pure (and separate from the data
// functions, which are reused unfiltered elsewhere) so they are unit-testable.

/** @param {{ mode?: string, workload?: string }} [f] mode: exact; workload: substring. */
export function filterPolicies(policies, f = {}) {
  return policies.filter((p) => {
    if (f.mode && String(p.Mode ?? "").toLowerCase() !== f.mode.toLowerCase()) return false;
    if (f.workload && !String(p.Workload ?? "").toLowerCase().includes(f.workload.toLowerCase())) return false;
    return true;
  });
}

/** @param {{ disabledOnly?: boolean, blockingOnly?: boolean }} [f] */
export function filterRules(rules, f = {}) {
  return rules.filter((r) => {
    if (f.disabledOnly && r.Disabled !== true) return false;
    if (f.blockingOnly && r.BlockAccess !== true) return false;
    return true;
  });
}

export async function createPolicy(params) {
  // params: { Name, Mode?, Locations?, EnforcementPlanes?, Comment?, ExchangeLocation?, ... }
  return powershell.invoke("New-DlpCompliancePolicy", params, POLICY_PROPS);
}

export async function setPolicy(params) {
  // params: { Identity, Mode?, Comment?, ... } — used to flip a policy between
  // a Test mode and Enable (enforce), or back. Only supplied fields change.
  return powershell.invoke("Set-DlpCompliancePolicy", params, POLICY_PROPS);
}

export async function createRule(params) {
  // params: { Name, Policy, ContentContainsSensitiveInformation?, BlockAccess?, NotifyUser?, ... }
  return powershell.invoke("New-DlpComplianceRule", params, RULE_PROPS);
}

export async function setRule(params) {
  // params: { Identity, ...properties to change }
  return powershell.invoke("Set-DlpComplianceRule", params, RULE_PROPS);
}

// Deletes: pass { Identity, Confirm: false } so the cmdlet's built-in
// confirmation prompt does not hang the non-interactive pwsh session.
export async function removePolicy(params) {
  return powershell.invoke("Remove-DlpCompliancePolicy", params);
}

export async function removeRule(params) {
  return powershell.invoke("Remove-DlpComplianceRule", params);
}

// ---- Copilot DLP helpers ---------------------------------------------------
// Microsoft 365 Copilot DLP rides the same New-DlpCompliancePolicy/Rule cmdlets;
// only the policy scoping (a Locations JSON string) and the label condition shape
// differ. Both stay in hashtable/array land the bridge already marshals.

// Well-known Microsoft 365 Copilot & Copilot Chat DLP location (Workload
// "Applications"), confirmed against Microsoft's New-DlpCompliancePolicy
// reference (Example 4):
// https://learn.microsoft.com/powershell/module/exchangepowershell/new-dlpcompliancepolicy
const COPILOT_LOCATION_ID = "470f2276-e011-4e9d-a6ec-20768be3a4b0";

/** Build the -Locations JSON string that scopes a DLP policy to Microsoft 365 Copilot. */
export function copilotLocations(userScope = ["All"]) {
  const scope = userScope?.length ? userScope : ["All"];
  const Inclusions = scope.map((id) =>
    id === "All" ? { Type: "Tenant", Identity: "All" } : { Type: "User", Identity: id }
  );
  return JSON.stringify([{ Workload: "Applications", Location: COPILOT_LOCATION_ID, Inclusions }]);
}

/**
 * Build the ContentContainsSensitiveInformation condition (a PswsHashtable[]) for a
 * Copilot rule from either SITs or sensitivity-label GUIDs. Microsoft disallows both
 * conditions in one rule, so exactly one must be supplied.
 * @param {{ sits?: string[], labels?: string[] }} input
 */
export function copilotCondition({ sits, labels } = {}) {
  if (sits?.length && labels?.length) {
    throw new Error("A Copilot rule cannot combine sensitive information types and sensitivity labels — use one condition per rule.");
  }
  if (sits?.length) return sits.map((n) => ({ Name: n }));
  if (labels?.length) return [{ groups: [{ operator: "Or", labels: labels.map((g) => ({ name: g, type: "Sensitivity" })) }] }];
  throw new Error("A Copilot rule needs a condition: sensitive_information_types or sensitivity_labels.");
}

/**
 * List Sensitive Information Types (SITs) visible to the tenant: built-in
 * Microsoft types and any custom types the org has created. Does NOT include
 * trainable classifiers, which are a separate classification mechanism with
 * no confirmed enumeration API (see README roadmap).
 * @param {"all"|"custom"} [scope]
 */
export async function listSensitiveInformationTypes(scope = "all", nameContains = null) {
  let sits = asArray(await powershell.invoke("Get-DlpSensitiveInformationType", {}, SIT_PROPS));
  if (scope === "custom") sits = sits.filter((s) => s.Publisher !== BUILTIN_SIT_PUBLISHER);
  if (nameContains) {
    const needle = nameContains.toLowerCase();
    sits = sits.filter((s) => String(s.Name ?? "").toLowerCase().includes(needle));
  }
  return sits;
}

// ---- formatters ------------------------------------------------------------

function sitName(sit) {
  // ContentContainsSensitiveInformation is an array of groups holding SITs
  // and/or sensitivity labels (Copilot label rules); surface both, or the
  // condition reads as empty and the rule looks like it detects nothing.
  if (!sit) return "";
  const groups = asArray(sit).flatMap((g) => asArray(g?.groups ?? g));
  const pick = (entries) =>
    asArray(entries)
      .map((t) => (typeof t === "string" ? t : t?.name ?? t?.Name))
      .filter(Boolean);
  const sits = groups.flatMap((g) => pick(g?.sensitivetypes ?? g?.Name ?? g?.name));
  const labels = groups.flatMap((g) => pick(g?.labels));
  const parts = [];
  if (sits.length) parts.push(`SIT: ${[...new Set(sits)].join(", ")}`);
  if (labels.length) parts.push(`labels: ${[...new Set(labels)].join(", ")}`);
  return parts.length ? ` [${parts.join("; ")}]` : "";
}

function policyLine(p) {
  const state = p.Enabled === false ? "disabled" : (p.Mode ?? "enabled");
  return `${truncate(p.Name, 44).padEnd(44)}  ${String(state).padEnd(12)}  ${truncate(p.Workload, 30) || "-"}  ${shortDate(p.WhenCreated)}`;
}

export function formatPolicyList(policies) {
  if (!policies.length) return "No DLP policies found.";
  const lines = policies.map(policyLine);
  return `${policies.length} DLP ${policies.length === 1 ? "policy" : "policies"}:\n${lines.join("\n")}`;
}

// Summarise the location fields into one compact line (e.g. "Exchange (All),
// SharePoint (3), Endpoint (excluded: 2)") rather than dumping the arrays.
function locationSummary(p) {
  const isAll = (v) => /^all$/i.test(String(v?.DisplayName ?? v?.Name ?? v ?? ""));
  const parts = [];
  for (const [field, label, excField] of POLICY_LOCATION_FIELDS) {
    const locs = asArray(p?.[field]);
    if (!locs.length) continue;
    const scope = locs.length === 1 && isAll(locs[0]) ? "All" : String(locs.length);
    const exc = excField ? asArray(p?.[excField]).length : 0;
    parts.push(`${label} (${scope}${exc ? `, excluded: ${exc}` : ""})`);
  }
  return parts.join(", ");
}

function exceptionSummary(r) {
  return RULE_EXCEPTION_FIELDS.filter(([f]) => asArray(r?.[f]).length).map(([, label]) => label).join(", ");
}

export function formatPolicyDetail(p) {
  if (!p) return "DLP policy not found.";
  const lines = [
    `# DLP policy: ${p.Name}`,
    bulletFields(p, [
      ["Guid", "GUID"],
      ["Mode", "Mode"],
      ["Enabled", "Enabled"],
      ["Workload", "Workload"],
      ["Type", "Type"],
      ["Comment", "Comment"],
      ["CreatedBy", "Created by"],
      ["WhenCreated", "Created"],
      ["WhenChangedUTC", "Last changed (UTC)"],
    ]),
  ];
  const locs = locationSummary(p);
  if (locs) lines.push(`- **Locations:** ${locs}`);
  return lines.filter(Boolean).join("\n");
}

function ruleLine(r) {
  const state = r.Disabled === true ? "disabled" : "enabled";
  const block = r.BlockAccess === true ? " BLOCK" : "";
  const prio = r.Priority != null ? `p${r.Priority}` : "p?";
  return `${truncate(r.Name, 40).padEnd(40)}  ${state.padEnd(9)}  ${prio.padEnd(4)}  policy:${truncate(r.ParentPolicyName ?? r.Policy, 24)}${block}${sitName(r.ContentContainsSensitiveInformation)}`;
}

export function formatRuleList(rules) {
  if (!rules.length) return "No DLP rules found.";
  const lines = rules.map(ruleLine);
  return `${rules.length} DLP rule(s):\n${lines.join("\n")}`;
}

export function formatRuleDetail(r) {
  if (!r) return "DLP rule not found.";
  const lines = [
    `# DLP rule: ${r.Name}`,
    bulletFields(r, [
      ["Guid", "GUID"],
      ["ParentPolicyName", "Policy"],
      ["Disabled", "Disabled"],
      ["Mode", "Mode"],
      ["Priority", "Priority"],
      ["BlockAccess", "Block access"],
      ["BlockAccessScope", "Block-access scope"],
      ["NotifyUser", "Notify users"],
      ["GenerateAlert", "Generate alert"],
      ["ReportSeverityLevel", "Severity"],
      ["StopPolicyProcessing", "Stops later rules"],
      ["Quarantine", "Quarantine"],
      ["GenerateIncidentReport", "Incident report to"],
      ["EncryptRMSTemplate", "Encryption template"],
    ]),
  ];
  const sits = sitName(r.ContentContainsSensitiveInformation);
  if (sits) lines.push(`- **Detected sensitive info:**${sits}`);
  const restrict = asArray(r.RestrictAccess)
    .map((a) => `${a?.setting ?? a?.Setting}=${a?.value ?? a?.Value}`)
    .filter((s) => !s.includes("undefined"));
  if (restrict.length) lines.push(`- **Restrict access:** ${restrict.join(", ")}`);
  const exc = exceptionSummary(r);
  if (exc) lines.push(`- **Exceptions:** ${exc}`);
  if (r.NotifyPolicyTipCustomText) lines.push("- **Policy tip:** configured");
  return lines.filter(Boolean).join("\n");
}

/** Full detail for several rules (e.g. every rule in a policy), one block each. */
export function formatRuleDetails(rules, policy) {
  if (!rules.length) return `No DLP rules found${policy ? ` in policy "${policy}"` : ""}.`;
  const intro = `${rules.length} DLP rule(s)${policy ? ` in policy: ${policy}` : ""}:`;
  return [intro, ...rules.map((r) => formatRuleDetail(r))].join("\n\n");
}

function sitLine(s) {
  const kind = s.Publisher !== BUILTIN_SIT_PUBLISHER ? "custom" : "built-in";
  return `${truncate(s.Name, 44).padEnd(44)}  ${kind.padEnd(9)}  ${truncate(s.Description, 60) || "-"}`;
}

export function formatSitList(sits, scope = "all") {
  if (!sits.length) {
    return scope === "custom" ? "No custom sensitive information types found." : "No sensitive information types found.";
  }
  const label = scope === "custom" ? "custom sensitive information type(s)" : "sensitive information type(s)";
  return `${sits.length} ${label}:\n${sits.map(sitLine).join("\n")}`;
}

