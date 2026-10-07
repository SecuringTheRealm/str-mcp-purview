import { createHash } from "node:crypto";
import { powershell } from "./powershell.js";
import { CapabilityError } from "./dispatch/errors.js";

const array = v => v == null ? [] : Array.isArray(v) ? v : [v];
const key = v => String(v ?? "").trim().toLowerCase();
const invalid = message => { throw new CapabilityError("VALIDATION_ERROR", message); };
const unavailable = message => { throw new CapabilityError("FEATURE_UNAVAILABLE", message); };
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const transient = /^(revision|Distribution|TestMode|Simulation|Progress|Execution|WhenChanged|WhenCreated|Last|Status)/i;
export function revisionOf(value) {
  const configuration = Object.fromEntries(Object.entries(value).filter(([k]) => !transient.test(k)));
  return createHash("sha256").update(JSON.stringify(stable(configuration))).digest("hex");
}
function exact(value, identity) {
  if (typeof identity !== "string" || !identity.trim()) invalid("Identity must be a non-empty name or GUID.");
  const found = array(value).filter(v => [v.Guid, v.Identity, v.Name].some(x => key(x) === key(identity)));
  if (found.length !== 1 || !found[0].Guid) throw new CapabilityError("TARGET_NOT_FOUND", "Identity must resolve to exactly one matching object with a stable GUID.");
  return found[0];
}
const policyCmd = "AutoSensitivityLabelPolicy", ruleCmd = "AutoSensitivityLabelRule";
const simulationConfigurations = new Map();
async function protectionFingerprint(policy) {
  const rules = array(await powershell.invoke(`Get-${ruleCmd}`, { Policy: policy.Guid }));
  const label = policy.ApplySensitivityLabel ? await powershell.invoke("Get-Label", { Identity: policy.ApplySensitivityLabel }) : null;
  const { Mode, Enabled, AutoEnableAfter, ...config } = policy;
  return revisionOf({ policy: revisionOf(config), rules: rules.map(r => ({ guid: r.Guid, revision: revisionOf(r) })).sort((a, b) => String(a.guid).localeCompare(String(b.guid))), label: label ? revisionOf(exact(label, policy.ApplySensitivityLabel)) : null });
}
export async function getPolicy(identity, options = {}) {
  const params = { Identity: identity };
  if (options.include_simulation_status) params.IncludeTestModeResults = true;
  if (options.include_progress) params.IncludeProgressFeedback = true;
  if (options.include_distribution_detail) params.DistributionDetail = true;
  if (options.include_administrative_unit_details) params.ForceValidate = true;
  const raw = exact(await powershell.invoke(`Get-${policyCmd}`, params), identity);
  // Diagnostics can change independently; a revision describes configuration.
  return { ...raw, revision: revisionOf(raw) };
}
export async function getRule(identity, options = {}) {
  const params = { Identity: identity };
  if (options.include_execution_rule_guids) params.IncludeExecutionRuleGuids = true;
  if (options.include_execution_rule_information) params.IncludeExecutionRuleInformation = true;
  const raw = exact(await powershell.invoke(`Get-${ruleCmd}`, params), identity);
  return { ...raw, revision: revisionOf(raw) };
}
export async function listPolicies() { return array(await powershell.invoke(`Get-${policyCmd}`)).map(p => ({ ...p, revision: revisionOf(p) })); }
export async function listRules(policyIdentity) {
  const policy = policyIdentity ? await getPolicy(policyIdentity) : undefined;
  return array(await powershell.invoke(`Get-${ruleCmd}`, policy ? { Policy: policy.Guid } : {})).map(r => ({ ...r, revision: revisionOf(r) }));
}
export function behaviour(p) { return p.RemoveLabel === true ? "remove" : p.DefaultSpoDocLibraryHasLabel === true ? "library_default" : "apply"; }
function checkRevision(current, args, mandatory = false) {
  if (mandatory && !args.expected_revision) invalid("Enablement requires expected_revision from a fresh policy read.");
  if (args.expected_revision && args.expected_revision !== current.revision) throw new CapabilityError("REVISION_CONFLICT", "Configuration changed; read the current object before retrying.");
}
const scopeFields = {
  sharepoint: { include_sites: "SharePointLocation", exclude_sites: "SharePointLocationException" },
  onedrive: { include_site_urls: "OneDriveLocation", exclude_site_urls: "OneDriveLocationException", include_users: "OneDriveSharedBy", exclude_users: "ExceptIfOneDriveSharedBy" },
  exchange: { include_senders: "ExchangeSender", exclude_senders: "ExchangeSenderException", include_sender_groups: "ExchangeSenderMemberOf", exclude_sender_groups: "ExchangeSenderMemberOfException" },
};
const locationName = { sharepoint: "SharePointLocation", onedrive: "OneDriveLocation", exchange: "ExchangeLocation" };
function validateScope(workload, scope) {
  if (scope.selection === "adaptive" || Object.keys(scope).some(k => k.includes("adaptive") && scope[k]?.length)) unavailable("Adaptive-scope mappings require tenant verification and are not enabled.");
  for (const [field, values] of Object.entries(scope)) {
    if (field !== "selection" && !scopeFields[workload][field] && values?.length) unavailable(`Scope field ${workload}.${field} is not yet supported.`);
    if (Array.isArray(values) && values.some(v => key(v) === "all")) invalid("Use selection:all explicitly instead of All in a collection.");
  }
  const includes = Object.entries(scope).some(([k, v]) => k.startsWith("include_") && v.length);
  const excludes = Object.entries(scope).some(([k, v]) => k.startsWith("exclude_") && v.length);
  if (scope.selection === "none" && (includes || excludes)) invalid("An excluded workload cannot have targets.");
  if (scope.selection === "selected" && (!includes || excludes)) invalid("Selected scope requires inclusions and no exclusions.");
  if (scope.selection === "all" && includes) invalid("All scope accepts exclusions, not inclusions.");
  if (workload === "onedrive" && scope.include_users?.length && scope.include_site_urls?.length) invalid("Do not mix OneDrive user and URL targeting.");
  if (workload === "onedrive" && scope.exclude_users?.length && scope.exclude_site_urls?.length) invalid("Do not mix OneDrive user and URL exclusions.");
  if (workload === "exchange") for (const field of ["include_sender_groups", "exclude_sender_groups"]) {
    if (scope[field]?.some(v => !/^[^\s@]+@[^\s@]+$/.test(v))) invalid("Exchange sender groups must be email addresses of supported mail-enabled groups.");
  }
  for (const field of ["include_sites", "exclude_sites", "include_site_urls", "exclude_site_urls"]) for (const url of scope[field] ?? []) {
    let parsed; try { parsed = new URL(url); } catch { invalid("Site locations must be absolute HTTPS URLs."); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) invalid("Site locations must be absolute HTTPS URLs without credentials.");
  }
}
function scopeParams(locations, current) {
  const params = {};
  for (const [workload, scope] of Object.entries(locations)) {
    validateScope(workload, scope);
    const field = locationName[workload];
    let targets = scope.selection === "none" ? [] : workload === "exchange" || scope.selection === "all" || (workload === "onedrive" && scope.include_users?.length) ? ["All"] : scope.include_sites ?? scope.include_site_urls ?? [];
    const desired = { [field]: targets };
    for (const [publicName, native] of Object.entries(scopeFields[workload])) {
      if (native !== field) desired[native] = scope[publicName] ?? [];
    }
    for (const [native, values] of Object.entries(desired)) {
      if (!current) { if (values.length) params[native] = values; }
      else if (/^(SharePointLocation|OneDriveLocation|ExchangeLocation)/.test(native)) {
        const previous = array(current[native]);
        const add = values.filter(v => !previous.some(x => key(x) === key(v)));
        const remove = previous.filter(v => !values.some(x => key(x) === key(v)));
        if (add.length) params[`Add${native}`] = add;
        if (remove.length) params[`Remove${native}`] = remove;
      } else if (JSON.stringify(array(current[native])) !== JSON.stringify(values)) params[native] = values;
    }
  }
  if (!current && !Object.values(locations).some(s => s.selection !== "none")) invalid("At least one workload must be explicitly included.");
  return params;
}
async function validateLabel(identity) {
  const label = exact(await powershell.invoke("Get-Label", { Identity: identity }), identity);
  const allLabels = array(await powershell.invoke("Get-Label"));
  if (label.IsLabelGroup || allLabels.some(l => key(l.ParentId?.Guid ?? l.ParentId) === key(label.Guid))) invalid("Select a leaf sensitivity label, not a parent/group label.");
  const policies = array(await powershell.invoke("Get-LabelPolicy"));
  const references = [label.Guid, label.Name].map(key);
  if (!policies.some(p => p.Enabled !== false && (array(p.ExchangeLocation).length || array(p.ModernGroupLocation).length) && array(p.Labels).some(l => references.includes(key(l.Guid ?? l.Name ?? l))))) invalid("The selected label must be published through an enabled label policy with explicit publication targets.");
  return label;
}
function policyConfig(args) {
  const p = {};
  if (args.description !== undefined) p.Comment = args.description;
  if (args.priority !== undefined) p.Priority = args.priority;
  if (args.administrative_unit_ids !== undefined) p.PolicyRBACScopes = args.administrative_unit_ids;
  if (args.existing_label_behaviour) {
    if (args.existing_label_behaviour.overwrite_workloads !== undefined) unavailable("Cross-workload overwrite encoding is not verified.");
    if (args.existing_label_behaviour.overwrite_manual_labels !== undefined) p.OverwriteLabel = args.existing_label_behaviour.overwrite_manual_labels;
  }
  if (args.external_email_protection?.rights_management_owner !== undefined) p.ExternalMailRightsManagementOwner = args.external_email_protection.rights_management_owner;
  return p;
}
function hasWorkload(p, w) { return array(p[locationName[w]]).length > 0; }
function validateProtection(params, current) {
  const merged = { ...current, ...params };
  if (params.OverwriteLabel !== undefined && !hasWorkload(merged, "exchange")) invalid("Manual-label overwrite requires Exchange targeting.");
  if (params.ExternalMailRightsManagementOwner && !hasWorkload(merged, "exchange")) invalid("External email protection requires Exchange targeting.");
}
async function mutate(cmdlet, params, getter, identity, simulation = false) {
  await (simulation ? powershell.invokeSimulation(cmdlet, params) : powershell.invoke(cmdlet, params));
  try { return { submission: "accepted", object: await getter(identity), enforcement_verified: false }; }
  catch { throw new CapabilityError("READBACK_FAILED", "The mutation was submitted, but readback failed. Its outcome is uncertain; inspect the object before retrying the write."); }
}
export async function createPolicy(args) {
  if (args.behaviour !== "apply") unavailable("Removal and library-default policies are reserved but their backend encodings are not verified.");
  if (!args.label_identity) invalid("Apply policies require label_identity.");
  const params = { Name: args.name, Mode: "Disable", SharePointLocation: [], OneDriveLocation: [], ExchangeLocation: [], ...policyConfig(args), ...scopeParams(args.locations) };
  validateProtection(params, {});
  const label = await validateLabel(args.label_identity);
  if (params.ExternalMailRightsManagementOwner && label.EncryptionEnabled !== true) invalid("External email protection requires an encryption label.");
  params.ApplySensitivityLabel = label.Guid;
  return mutate(`New-${policyCmd}`, params, getPolicy, args.name);
}
export async function setPolicy(args) {
  if (Object.keys(args).every(k => ["identity", "expected_revision"].includes(k))) invalid("Provide at least one change or action.");
  const config = policyConfig(args);
  if (args.location_changes && args.locations) invalid("Use either locations or location_changes in one request.");
  if (args.enabled !== undefined) unavailable("The interaction of Enabled and Mode is not verified; use mode to change the policy state.");
  if (args.restart_simulation && args.mode !== "TestWithoutNotifications") invalid("Restart simulation requires mode:TestWithoutNotifications.");
  if (args.retry_distribution && Object.keys(args).some(k => !["identity", "retry_distribution", "expected_revision"].includes(k))) invalid("Distribution retry must be requested separately from configuration and lifecycle changes.");
  let duration;
  if (args.auto_enable_after != null) {
    const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(args.auto_enable_after);
    if (!match || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) invalid("Use duration dd.hh:mm:ss.");
    duration = (+match[1] || 0) * 86400 + +match[2] * 3600 + +match[3] * 60 + +match[4];
    if (duration < 3600 || duration > 25 * 86400 || !args.restart_simulation) invalid("Scheduled enablement requires a simulation restart and a duration between 1 hour and 25 days.");
    unavailable("Scheduled automatic enablement is reserved until its authorization and simulation eligibility can be verified at activation time.");
  }
  const current = await getPolicy(args.identity);
  let replacementLocations = args.locations;
  if (args.location_changes) {
    replacementLocations = {};
    for (const [workload, fields] of Object.entries(args.location_changes)) {
      const scope = {};
      for (const [field, delta] of Object.entries(fields)) {
        const native = scopeFields[workload]?.[field];
        if (!native) unavailable(`Location delta ${workload}.${field} requires a verified backend mapping.`);
        if (delta.add?.some(x => delta.remove?.some(y => key(x) === key(y)))) invalid("A location cannot be added and removed in the same delta.");
        const previous = array(current[native]);
        scope[field] = [...new Set(previous.filter(v => !delta.remove?.some(x => key(x) === key(v))).concat(delta.add ?? []))];
      }
      for (const [field, native] of Object.entries(scopeFields[workload])) if (scope[field] === undefined) scope[field] = array(current[native]).filter(v => key(v) !== "all");
      const locationsNow = scope.include_sites ?? scope.include_site_urls ?? [];
      const included = Object.entries(scope).some(([k, v]) => k.startsWith("include_") && Array.isArray(v) && v.length);
      scope.selection = array(current[locationName[workload]]).some(v => key(v) === "all") && !included ? "all" : "selected";
      if (!locationsNow.length && !Object.entries(scope).some(([k, v]) => k.startsWith("include_") && Array.isArray(v) && v.length) && scope.selection !== "all") scope.selection = "none";
      replacementLocations[workload] = scope;
    }
  }
  checkRevision(current, args, args.mode === "Enable");
  if (behaviour(current) !== "apply") unavailable("Updates to removal/library-default policies are not yet supported.");
  const editing = replacementLocations || args.label_identity || args.existing_label_behaviour || args.external_email_protection || args.administrative_unit_ids || args.priority !== undefined || args.description !== undefined;
  if (editing && args.mode === "Enable") invalid("Configure and simulate changes separately before enabling.");
  if (editing && current.Mode === "Enable" && args.mode !== "Disable") invalid("Disable the policy before changing its effective protection configuration.");
  if (args.mode === "Enable") {
    const snapshot = simulationConfigurations.get(current.Guid);
    if (!snapshot || snapshot !== await protectionFingerprint(current)) throw new CapabilityError("SIMULATION_REQUIRED", "Run simulation through this server for the current policy, rules and label configuration before enabling. Restarting the server requires a new simulation.");
    const status = await getPolicy(current.Guid, { include_simulation_status: true });
    const state = status.TestModeStatus ?? status.SimulationStatus ?? status.TestModeResults?.Status;
    if (!["completed", "simulation complete"].includes(key(state))) throw new CapabilityError("SIMULATION_REQUIRED", "A completed simulation could not be verified. Review simulation in Purview; enablement remains blocked until backend status is verified.");
    if (!(await listRules(current.Guid)).some(r => r.Disabled !== true)) invalid("An enabled policy requires at least one active rule.");
  }
  const params = { Identity: current.Guid, ...config, ...(replacementLocations ? scopeParams(replacementLocations, current) : {}) };
  if (args.label_identity) params.ApplySensitivityLabel = (await validateLabel(args.label_identity)).Guid;
  if (args.mode !== undefined) params.Mode = args.mode;
  if (args.restart_simulation) params.StartSimulation = true;
  if (args.auto_enable_after === null || editing) params.AutoEnableAfter = null;
  if (args.retry_distribution) params.RetryDistribution = true;
  // Validate resulting scope, including deltas, before submitting.
  const effective = { ...current };
  for (const native of Object.values(locationName)) {
    effective[native] = array(current[native]).filter(v => !array(params[`Remove${native}`]).some(x => key(x) === key(v))).concat(array(params[`Add${native}`]));
  }
  validateProtection(params, effective);
  if (!Object.values(locationName).some(n => array(effective[n]).length)) invalid("The resulting policy must include at least one workload.");
  if (editing || args.restart_simulation) simulationConfigurations.delete(current.Guid);
  const result = await mutate(`Set-${policyCmd}`, params, getPolicy, current.Guid, args.restart_simulation === true);
  if (args.restart_simulation) simulationConfigurations.set(current.Guid, await protectionFingerprint(result.object));
  return result;
}

const nativePredicates = {
  access_scope: "AccessScope", file_extensions: "ContentExtensionMatchesWords", document_name_contains_words: "DocumentNameMatchesWords",
  content_properties: "ContentPropertyContainsWords", document_size_over: "DocumentSizeOver", document_is_password_protected: "DocumentIsPasswordProtected",
  document_is_unsupported: "DocumentIsUnsupported", processing_limit_exceeded: "ProcessingLimitExceeded",
  sender_address_contains_words: "FromAddressContainsWords", sender_address_matches_patterns: "FromAddressMatchesPatterns", sender_domains: "SenderDomainIs", sender_ip_ranges: "SenderIPRanges",
  recipients: "SentTo", recipient_groups: "SentToMemberOf", recipient_domains: "RecipientDomainIs", recipient_address_contains_words: "AnyOfRecipientAddressContainsWords",
  recipient_address_matches_patterns: "AnyOfRecipientAddressMatchesPatterns", subject_matches_patterns: "SubjectMatchesPatterns", senders: "From", sender_groups: "FromMemberOf",
};
const exchangeOnly = new Set(["document_size_over", "document_is_password_protected", "document_is_unsupported", "processing_limit_exceeded", "sender_address_contains_words", "sender_address_matches_patterns", "sender_domains", "sender_ip_ranges", "recipients", "recipient_groups", "recipient_domains", "recipient_address_contains_words", "recipient_address_matches_patterns", "subject_matches_patterns", "header_matches_patterns", "senders", "sender_groups"]);
function sensitiveParams(value) {
  if (value.groups.length !== 1 || value.groups[0].operator !== "any") unavailable("Only a single OR detector group is currently supported; advanced Boolean/EDM encodings require verification.");
  return value.groups[0].detectors.map(d => {
    if (d.kind !== "sit") unavailable("EDM and trainable-classifier mappings are not yet verified.");
    if (d.confidence_level && (d.min_confidence !== undefined || d.max_confidence !== undefined)) invalid("Choose named or numeric confidence, not both.");
    if (d.max_count !== undefined && d.max_count !== -1 && (d.max_count < 1 || d.max_count < (d.min_count ?? 1))) invalid("max_count must be unlimited (-1) or at least min_count.");
    const p = { Name: d.identity };
    if (d.min_count !== undefined) p.minCount = d.min_count;
    if (d.max_count !== undefined) p.maxCount = d.max_count;
    if (d.confidence_level) p.minConfidence = { Low: 65, Medium: 75, High: 85 }[d.confidence_level];
    if (d.min_confidence !== undefined) p.minConfidence = d.min_confidence;
    if (d.max_confidence !== undefined) p.maxConfidence = d.max_confidence;
    if (p.minConfidence > p.maxConfidence) invalid("Minimum confidence cannot exceed maximum confidence.");
    return p;
  });
}
export function ruleParams(args, workload, parent) {
  if (args.expression !== undefined || args.label_to_remove !== undefined) unavailable("Advanced expressions and label-removal encodings are not yet verified.");
  const p = {};
  for (const [part, prefix] of [["conditions", ""], ["exceptions", "ExceptIf"]]) for (const [field, value] of Object.entries(args[part] ?? {})) {
    if (field !== "sensitive_information" && !nativePredicates[field] && !["document_created_by", "header_matches_patterns"].includes(field)) invalid(`Unknown rule predicate: ${field}.`);
    if (field === "document_created_by" || field === "header_matches_patterns") unavailable(`The backend encoding for ${field} is not verified.`);
    if (exchangeOnly.has(field) && (workload !== "Exchange" || hasWorkload(parent, "sharepoint") || hasWorkload(parent, "onedrive"))) invalid(`${field} requires an Exchange-only parent policy.`);
    if (Array.isArray(value) && !value.length) unavailable("Clearing condition lists requires verified backend clear semantics.");
    if (/matches_patterns$/.test(field) && (value.length > 10 || value.some(s => s.length > 128))) invalid("Address/subject patterns support at most 10 expressions of 128 characters each.");
    if (["sender_address_contains_words", "document_name_contains_words", "recipient_address_contains_words"].includes(field) && (value.length > (field === "recipient_address_contains_words" ? 600 : 50) || value.some(s => s.length > 128))) invalid("Word condition exceeds its documented count or length limit.");
    if (field === "sensitive_information") p[`${prefix}ContentContainsSensitiveInformation`] = sensitiveParams(value);
    else if (field === "content_properties") {
      if (value.some(v => /[:,]/.test(v.property) || v.values.some(x => /,/.test(x)))) invalid("Property names and values cannot contain backend delimiters.");
      p[`${prefix}ContentPropertyContainsWords`] = value.map(v => `${v.property}:${v.values.join(",")}`);
    } else p[`${prefix}${nativePredicates[field]}`] = value;
  }
  if (args.description !== undefined) p.Comment = args.description;
  if (args.disabled !== undefined) p.Disabled = args.disabled;
  if (args.report_severity_level !== undefined) p.ReportSeverityLevel = args.report_severity_level;
  if (args.rule_error_action !== undefined) p.RuleErrorAction = args.rule_error_action;
  return p;
}
async function ruleParent(current) {
  const ref = current.ParentPolicyName ?? current.Policy ?? current.ParentPolicyId;
  if (!ref) unavailable("Cannot resolve the rule's parent policy for validation.");
  return getPolicy(ref.Guid ?? ref.Name ?? ref);
}
function assertRuleScope(workload, parent) {
  const w = { SharePoint: "sharepoint", OneDriveForBusiness: "onedrive", Exchange: "exchange" }[workload];
  if (!w || !hasWorkload(parent, w)) invalid("The rule workload must be included in its parent policy.");
  if (parent.Mode === "Enable") invalid("Disable the parent policy before modifying its rules.");
  if (behaviour(parent) !== "apply") unavailable("Removal/library-default rule writes are not supported yet.");
}
export async function createRule(args) {
  if (!Object.keys(args.conditions ?? {}).length) invalid("A rule requires at least one condition.");
  const parent = await getPolicy(args.policy_identity);
  assertRuleScope(args.workload, parent);
  const params = { Name: args.name, Policy: parent.Guid, Workload: args.workload, ...ruleParams(args, args.workload, parent) };
  return mutate(`New-${ruleCmd}`, params, getRule, args.name);
}
export async function setRule(args) {
  if (Object.keys(args).every(k => ["identity", "expected_revision"].includes(k))) invalid("Provide at least one change.");
  const current = await getRule(args.identity); checkRevision(current, args);
  const parent = await ruleParent(current), workload = args.workload ?? current.Workload;
  assertRuleScope(workload, parent);
  const params = { Identity: current.Guid, ...ruleParams(args, workload, parent) };
  if (args.workload) params.Workload = args.workload;
  if (Object.keys(params).length === 1) invalid("No supported changes were supplied.");
  return mutate(`Set-${ruleCmd}`, params, getRule, current.Guid);
}
export async function removePolicy(args) { const p = await getPolicy(args.identity); checkRevision(p, args); await powershell.invoke(`Remove-${policyCmd}`, { Identity: p.Guid, Confirm: false }); return { submission: "accepted", identity: p.Guid, existing_labels_reversed: false }; }
export async function removeRule(args) { const r = await getRule(args.identity); checkRevision(r, args); await powershell.invoke(`Remove-${ruleCmd}`, { Identity: r.Guid, Confirm: false }); return { submission: "accepted", identity: r.Guid, existing_labels_reversed: false }; }
