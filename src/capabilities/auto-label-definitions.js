// Public service-side auto-labeling contract. Advanced fields are reserved but
// explicitly rejected by the adapter until their backend encoding is verified.
const object = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const string = { type: "string", minLength: 1 };
const strings = { type: "array", items: string, uniqueItems: true };
const bool = { type: "boolean" };
const workload = { enum: ["SharePoint", "OneDriveForBusiness", "Exchange"] };
const mode = { enum: ["Disable", "TestWithoutNotifications", "Enable"] };
const revision = { ...string, description: "Optional configuration fingerprint from a previous read; checked before mutation, not an atomic backend lock." };
const collectionKeys = {
  sharepoint: ["include_sites", "exclude_sites", "include_adaptive_scope_ids", "exclude_adaptive_scope_ids"],
  onedrive: ["include_users", "exclude_users", "include_groups", "exclude_groups", "include_site_urls", "exclude_site_urls", "include_adaptive_scope_ids", "exclude_adaptive_scope_ids"],
  exchange: ["include_senders", "exclude_senders", "include_sender_groups", "exclude_sender_groups", "include_adaptive_scope_ids", "exclude_adaptive_scope_ids"],
};
const locations = object(Object.fromEntries(Object.entries(collectionKeys).map(([key, fields]) => [key, object({ selection: { enum: ["none", "all", "selected", "adaptive"] }, ...Object.fromEntries(fields.map(f => [f, strings])) }, ["selection"])])));
const changes = object(Object.fromEntries(Object.entries(collectionKeys).map(([key, fields]) => [key, object(Object.fromEntries(fields.map(f => [f, object({ add: strings, remove: strings })])))])));
const config = {
  label_identity: string, description: { type: "string" }, priority: { type: "integer", minimum: 0 }, locations,
  administrative_unit_ids: { type: "array", uniqueItems: true, items: { type: "string", pattern: "^[a-fA-F0-9]{8}(-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$" } },
  existing_label_behaviour: object({ overwrite_manual_labels: bool, overwrite_workloads: { type: "array", items: workload, uniqueItems: true } }),
  external_email_protection: object({ rights_management_owner: { type: ["string", "null"], pattern: "^[^\\s@]+@[^\\s@]+$" } }),
};
const detector = object({ kind: { enum: ["sit", "edm", "trainable_classifier"] }, identity: string,
  min_count: { type: "integer", minimum: 1 }, max_count: { type: "integer", minimum: -1 },
  confidence_level: { enum: ["Low", "Medium", "High"] }, min_confidence: { type: "integer", minimum: 0, maximum: 100 }, max_confidence: { type: "integer", minimum: 0, maximum: 100 },
}, ["kind", "identity"]);
const sensitive = object({ operator: { enum: ["all", "any"] }, groups: { type: "array", minItems: 1, items: object({ name: string, operator: { enum: ["all", "any"] }, detectors: { type: "array", minItems: 1, items: detector } }, ["name", "operator", "detectors"]) } }, ["operator", "groups"]);
const predicates = {
  sensitive_information: sensitive, access_scope: { enum: ["InOrganization", "NotInOrganization"] },
  file_extensions: strings, document_name_contains_words: strings,
  content_properties: { type: "array", items: object({ property: string, values: { ...strings, minItems: 1 } }, ["property", "values"]) },
  document_created_by: strings, document_size_over: { type: "string", pattern: "^[0-9]+(\\.[0-9]+)? ?(B|KB|MB|GB|TB)$" },
  document_is_password_protected: bool, document_is_unsupported: bool, processing_limit_exceeded: bool,
  sender_address_contains_words: strings, sender_address_matches_patterns: strings, sender_domains: strings, sender_ip_ranges: strings,
  recipients: strings, recipient_groups: strings, recipient_domains: strings,
  recipient_address_contains_words: strings, recipient_address_matches_patterns: strings, subject_matches_patterns: strings,
  header_matches_patterns: { type: "array", items: object({ header: string, patterns: { ...strings, minItems: 1 } }, ["header", "patterns"]) },
};
const matching = {
  conditions: object(predicates), exceptions: object({ ...predicates, senders: strings, sender_groups: strings }),
  expression: { type: "object", description: "Reserved advanced Boolean expression. Currently unavailable: backend encoding is not verified.", additionalProperties: true },
  label_to_remove: string,
};
const ruleConfig = { ...matching, description: { type: "string" }, disabled: bool,
  report_severity_level: { enum: ["None", "Low", "Medium", "High"] }, rule_error_action: { enum: ["Ignore", "RetryThenBlock", null] } };
const paging = { limit: { type: "integer", minimum: 1, maximum: 100, default: 25 }, cursor: { ...string, maxLength: 2048 } };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const tool = (name, description, properties, required = [], annotations = read) => ({ name, description, inputSchema: object(properties, required), annotations: { ...annotations, title: name.replaceAll("_", " ").replace(/^./, c => c.toUpperCase()), ...(name.startsWith("create_") ? { destructiveHint: false } : {}) } });
export const AUTO_LABEL_TOOLS = [
  tool("list_auto_label_policies", "List service-side automatic sensitivity labeling policies with filters and pagination.", { ...paging, name_contains: string, workload, mode, enabled: bool, behaviour: { enum: ["apply", "remove", "library_default"] }, label_identity: string }),
  tool("get_auto_label_policy", "Inspect an auto-label policy, revision, simulation status, labeling progress and distribution diagnostics. Does not retrieve portal sample items.", { identity: string, include_simulation_status: bool, include_progress: bool, include_distribution_detail: bool, include_administrative_unit_details: bool }, ["identity"]),
  tool("create_auto_label_policy", "Create a scoped auto-label policy explicitly disabled. Only apply behaviour is currently supported; advanced options fail explicitly.", { name: string, behaviour: { enum: ["apply", "remove", "library_default"] }, ...config }, ["name", "behaviour", "locations"], write),
  tool("set_auto_label_policy", "Update an auto-label policy, change mode, restart simulation, schedule enablement or retry distribution. Actions are not automatically retryable. Enablement requires completed simulation and expected_revision.", { identity: string, ...config, location_changes: changes, mode, enabled: bool, restart_simulation: bool, auto_enable_after: { type: ["string", "null"], pattern: "^([0-9]+\\.)?[0-9]{1,2}:[0-9]{2}:[0-9]{2}$" }, retry_distribution: bool, expected_revision: revision }, ["identity"], write),
  tool("remove_auto_label_policy", "Delete an auto-label policy after server-driven form elicitation. Existing content labels are not reversed.", { identity: string, expected_revision: revision }, ["identity"], write),
  tool("list_auto_label_rules", "List automatic sensitivity label rules, optionally filtered to a policy, with pagination.", { ...paging, policy_identity: string, name_contains: string, workload, disabled: bool }),
  tool("get_auto_label_rule", "Inspect one auto-label rule and revision, optionally including execution-rule diagnostics.", { identity: string, include_execution_rule_guids: bool, include_execution_rule_information: bool }, ["identity"]),
  tool("create_auto_label_rule", "Create a workload-specific auto-label rule with typed sensitive-information conditions and exceptions. Advanced expressions and removal targets are currently unavailable.", { name: string, policy_identity: string, workload, ...ruleConfig }, ["name", "policy_identity", "workload", "conditions"], write),
  tool("set_auto_label_rule", "Modify an auto-label rule. Omitted fields remain unchanged; supplied condition fields replace those fields. Rule priority is internal-only and is not exposed.", { identity: string, workload, ...ruleConfig, expected_revision: revision }, ["identity"], write),
  tool("remove_auto_label_rule", "Delete an auto-label rule after server-driven form elicitation; stops future matching without undoing existing labels.", { identity: string, expected_revision: revision }, ["identity"], write),
];
export const autoLabelExamples = {
  list_auto_label_policies: { limit: 25 }, get_auto_label_policy: { identity: "Example-Auto-Policy", include_simulation_status: true },
  create_auto_label_policy: { name: "Example-Auto-Policy", behaviour: "apply", label_identity: "Example-Label", locations: { sharepoint: { selection: "selected", include_sites: ["https://contoso.sharepoint.com/sites/Finance"] } } },
  set_auto_label_policy: { identity: "Example-Auto-Policy", mode: "Disable" }, remove_auto_label_policy: { identity: "Example-Auto-Policy" },
  list_auto_label_rules: { policy_identity: "Example-Auto-Policy", limit: 25 }, get_auto_label_rule: { identity: "Example-Auto-Rule" },
  create_auto_label_rule: { name: "Example-Auto-Rule", policy_identity: "Example-Auto-Policy", workload: "SharePoint", conditions: { sensitive_information: { operator: "any", groups: [{ name: "Identifiers", operator: "any", detectors: [{ kind: "sit", identity: "Credit Card Number", min_count: 1 }] }] } } },
  set_auto_label_rule: { identity: "Example-Auto-Rule", disabled: true }, remove_auto_label_rule: { identity: "Example-Auto-Rule" },
};
