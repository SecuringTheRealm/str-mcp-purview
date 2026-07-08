// DLP policy/rule tools, backed by the Security & Compliance PowerShell bridge.
// Reads use Get-DlpCompliance*, writes use New-/Set-DlpCompliance*.

import { powershell } from "./powershell.js";
import { truncate, shortDate, asArray, bulletFields } from "./format.js";

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

// Per Microsoft docs, custom SITs always report a Publisher other than this
// value: https://learn.microsoft.com/purview/sit-create-a-custom-sensitive-information-type-in-scc-powershell
const BUILTIN_SIT_PUBLISHER = "Microsoft Corporation";

// ---- data access -----------------------------------------------------------

export async function listPolicies() {
  return asArray(await powershell.invoke("Get-DlpCompliancePolicy", {}, POLICY_PROPS));
}

export async function getPolicy(identity) {
  return asArray(await powershell.invoke("Get-DlpCompliancePolicy", { Identity: identity }, POLICY_PROPS))[0];
}

export async function listRules(policy) {
  const params = policy ? { Policy: policy } : {};
  return asArray(await powershell.invoke("Get-DlpComplianceRule", params, RULE_PROPS));
}

export async function createPolicy(params) {
  // params: { Name, Mode?, Locations?, EnforcementPlanes?, Comment?, ExchangeLocation?, ... }
  return powershell.invoke("New-DlpCompliancePolicy", params, POLICY_PROPS);
}

export async function createRule(params) {
  // params: { Name, Policy, ContentContainsSensitiveInformation?, BlockAccess?, NotifyUser?, ... }
  return powershell.invoke("New-DlpComplianceRule", params, RULE_PROPS);
}

export async function setRule(params) {
  // params: { Identity, ...properties to change }
  return powershell.invoke("Set-DlpComplianceRule", params, RULE_PROPS);
}

/**
 * List Sensitive Information Types (SITs) visible to the tenant: built-in
 * Microsoft types and any custom types the org has created. Does NOT include
 * trainable classifiers, which are a separate classification mechanism with
 * no confirmed enumeration API (see README roadmap).
 * @param {"all"|"custom"} [scope]
 */
export async function listSensitiveInformationTypes(scope = "all") {
  const sits = asArray(await powershell.invoke("Get-DlpSensitiveInformationType", {}, SIT_PROPS));
  return scope === "custom" ? sits.filter((s) => s.Publisher !== BUILTIN_SIT_PUBLISHER) : sits;
}

// ---- formatters ------------------------------------------------------------

function sitName(sit) {
  // ContentContainsSensitiveInformation is an array of groups; surface names.
  if (!sit) return "";
  const names = asArray(sit)
    .flatMap((g) => asArray(g?.groups ?? g))
    .flatMap((g) => asArray(g?.sensitivetypes ?? g?.Name ?? g?.name))
    .map((t) => (typeof t === "string" ? t : t?.name ?? t?.Name))
    .filter(Boolean);
  return names.length ? ` [SIT: ${[...new Set(names)].join(", ")}]` : "";
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

export function formatPolicyDetail(p) {
  if (!p) return "DLP policy not found.";
  return [
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
  ].join("\n");
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

export function formatWriteResult(verb, obj) {
  const item = asArray(obj)[0] ?? obj;
  if (!item) return `${verb} completed.`;
  const id = item.Name ?? item.Identity ?? item.Guid ?? "(unknown)";
  return `${verb} succeeded: ${id}\n${bulletFields(item, [
    ["Guid", "GUID"],
    ["Policy", "Policy"],
    ["ParentPolicyName", "Policy"],
    ["Mode", "Mode"],
    ["Enabled", "Enabled"],
    ["Disabled", "Disabled"],
    ["Priority", "Priority"],
    ["BlockAccess", "Block access"],
  ])}`;
}
