export const cases = [
  { query: "Find DLP policies that apply to SharePoint", expected: "list_dlp_policies", domain: "dlp" },
  { query: "Show the rules for this DLP policy", expected: "get_dlp_rule", domain: "dlp" },
  { query: "List sensitivity labels", expected: "list_sensitivity_labels", domain: "labels" },
  { query: "Get the configuration for this label", expected: "get_sensitivity_label", domain: "labels" },
  { query: "Create a new DLP rule", expected: "create_dlp_rule", domain: "dlp" },
  { query: "Check authentication status", expected: "get_auth_status", domain: "auth" },
  { query: "Delete a label publishing policy", expected: "remove_label_policy", domain: "labels" },
  { query: "Find custom sensitive information types", expected: "list_sensitive_information_types", domain: "classification" },
  { query: "Modify Endpoint DLP rule restrictions", expected: "set_dlp_rule", domain: "dlp" },
  { query: "Create Copilot DLP policy", expected: "create_copilot_dlp_policy", domain: "dlp" },
];
