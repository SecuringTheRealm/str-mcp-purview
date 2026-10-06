import { TOOLS } from "./definitions.js";
import { handlers as labels } from "./labels.js";
import { handlers as dlp } from "./dlp.js";
import { authStatus } from "./auth.js";
import { defineCapability, validateRegistry, indexCapabilities } from "./contract.js";
import { examples } from "./examples.js";
export { validateRegistry } from "./contract.js";

const authTool = {
  name: "get_auth_status",
  description: "Check local authentication configuration without signing in; does not verify credentials or tenant permissions.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "Authentication configuration", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const handlers = { ...labels, ...dlp, get_auth_status: authStatus };
const vocabulary = {
  labels: ["sensitivity", "classification", "label", "publishing", "information protection"],
  dlp: ["DLP", "data loss prevention", "compliance", "SharePoint", "OneDrive", "Exchange", "Teams"],
  classification: ["SIT", "sensitive information type", "detector", "classification"],
  auth: ["authentication", "status", "credentials", "sign in", "configuration"],
};

// Explicit exceptions/extensions to the convention-based metadata below. Keep
// scope alternatives separate: any one complete set satisfies this local gate.
const metadata = {
  get_label_policy_settings: {
    scopeAlternatives: [["InformationProtectionPolicy.Read"], ["InformationProtectionPolicy.Read.All"]],
  },
};

// Existing names are stable capability IDs, preserving scripts and saved cursors.
export const capabilities = validateRegistry([...TOOLS, authTool].map((tool) => {
  const domain = tool.name === "get_auth_status" ? "auth"
    : tool.name.includes("sensitive_information") ? "classification"
      : tool.name.includes("dlp") ? "dlp" : "labels";
  const verb = tool.name.split("_")[0];
  const action = tool.annotations.readOnlyHint ? "read" : "write";
  const capability = defineCapability({
    id: tool.name,
    domain,
    action,
    examples: [{ description: "Illustrative arguments; replace example identities and only perform requested changes.", arguments: examples[tool.name] }],
    constraints: ["Microsoft backend authorization still applies.", ...(tool.name.startsWith("remove_") ? ["Deletion requires user confirmation through form elicitation; confirm:true alone is insufficient."] : [])],
    operation: ({ set: "update", remove: "delete" })[verb] ?? verb,
    idempotent: tool.annotations.idempotentHint,
    openWorld: tool.annotations.openWorldHint,
    risk: action === "read" ? "read-only" : tool.annotations.destructiveHint ? "destructive" : "non-destructive",
    destructive: tool.annotations.destructiveHint,
    nouns: tool.name.split("_").slice(1),
    keywords: [...vocabulary[domain], ...tool.name.split("_"), verb === "list" ? "find enumerate catalog" : verb === "get" ? "show inspect configuration details" : verb === "set" ? "update modify tune" : verb],
    description: tool.description.split(". ")[0].slice(0, 300),
    aliases: [],
    permissions: [],
    scopeAlternatives: [],
    features: [],
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    ...metadata[tool.name],
    handler: handlers[tool.name],
  });
  // Preserve detailed legacy descriptions and annotations on the full surface.
  return { ...capability, tool };
}));

export const capabilityById = indexCapabilities(capabilities);
