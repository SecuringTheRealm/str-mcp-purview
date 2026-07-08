#!/usr/bin/env node
// str-mcp-purview — local MCP server for Microsoft Purview data security.
//
// Developed by Securing the Realm (https://securing.quest/):
//   Chris Lloyd-Jones (Sealjay) & Josh McDonald (KnowledgeRatio).
// Licensed under MIT — this attribution notice must be retained (see LICENCE).
//
// Two planes, as required by the current Purview developer surface:
//   * Microsoft Graph (beta) — sensitivity label discovery (read).
//   * Security & Compliance PowerShell — DLP policy/rule CRUD (read + write),
//     because that config surface is not exposed through Graph.
//
// Runs over stdio as the signed-in admin (delegated auth), so every action
// respects that admin's Purview RBAC. Structure mirrors nvd-mcp-local: the
// low-level Server API, compact/markdown formatters, and prompts that chain
// tools into review workflows.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import * as labels from "./src/labels.js";
import * as dlp from "./src/dlp.js";

// ---- tool definitions ------------------------------------------------------

const TOOLS = [
  {
    name: "list_sensitivity_labels",
    description:
      "List the Microsoft Purview Information Protection sensitivity labels available to the signed-in admin, via Microsoft Graph. One compact line per label.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_sensitivity_label",
    description:
      "Get full details of a single sensitivity label (color, tooltip, parent, sensitivity order) by its label ID.",
    inputSchema: {
      type: "object",
      required: ["label_id"],
      properties: {
        label_id: { type: "string", description: "Sensitivity label GUID, from list_sensitivity_labels" },
      },
    },
  },
  {
    name: "get_label_policy_settings",
    description:
      "Get the Information Protection label policy settings for the signed-in admin (mandatory labeling, downgrade justification, default label).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_dlp_policies",
    description:
      "List Data Loss Prevention (DLP) policies in Microsoft Purview via Security & Compliance PowerShell. One compact line per policy.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_dlp_policy",
    description: "Get details of a single DLP policy by name or GUID.",
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "DLP policy name or GUID" },
      },
    },
  },
  {
    name: "list_dlp_rules",
    description:
      "List DLP rules, optionally filtered to one policy. Shows state, priority, block action, and detected sensitive information types.",
    inputSchema: {
      type: "object",
      properties: {
        policy: { type: "string", description: "Optional: restrict to rules in this DLP policy (name or GUID)" },
      },
    },
  },
  {
    name: "create_dlp_policy",
    description:
      "Create a new DLP policy (New-DlpCompliancePolicy). Creates the container; add rules with create_dlp_rule. WRITE operation — this changes tenant configuration.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Unique policy name" },
        mode: {
          type: "string",
          enum: ["Enable", "TestWithNotifications", "TestWithoutNotifications", "Disable"],
          description: "Policy mode (default Enable)",
        },
        comment: { type: "string", description: "Optional description/comment" },
        exchange_location: {
          type: "array",
          items: { type: "string" },
          description: "Exchange locations, e.g. ['All']. Simple alternative to raw locations.",
        },
        sharepoint_location: {
          type: "array",
          items: { type: "string" },
          description: "SharePoint locations, e.g. ['All'].",
        },
        onedrive_location: {
          type: "array",
          items: { type: "string" },
          description: "OneDrive locations, e.g. ['All'].",
        },
      },
    },
  },
  {
    name: "set_dlp_policy",
    description:
      "Modify an existing DLP policy (Set-DlpCompliancePolicy). Primary use: change a policy's mode to move it between a Test mode and enforcement (Enable), or back. Only supplied fields change. WRITE operation — this changes tenant configuration.",
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "DLP policy name or GUID to modify" },
        mode: {
          type: "string",
          enum: ["Enable", "TestWithNotifications", "TestWithoutNotifications", "Disable"],
          description:
            "New policy mode. Enable = enforce; TestWithNotifications/TestWithoutNotifications = test; Disable = turn off.",
        },
        comment: { type: "string", description: "Optional: replace the policy's description/comment" },
      },
    },
  },
  {
    name: "create_dlp_rule",
    description:
      "Create a DLP rule inside a policy (New-DlpComplianceRule). A rule needs at least one condition and one action. WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["name", "policy"],
      properties: {
        name: { type: "string", description: "Unique rule name" },
        policy: { type: "string", description: "Parent DLP policy name or GUID" },
        sensitive_information_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Condition: names of sensitive information types to detect, e.g. ['Credit Card Number','U.S. Social Security Number (SSN)'].",
        },
        block_access: { type: "boolean", description: "Action: block access to matching content" },
        notify_user: {
          type: "array",
          items: { type: "string" },
          description: "Action: notify these users (email addresses, or ['LastModifier','Owner']).",
        },
        generate_alert: { type: "boolean", description: "Action: raise an alert on match" },
        priority: { type: "integer", description: "Rule priority (lower runs first)" },
      },
    },
  },
  {
    name: "set_dlp_rule",
    description:
      "Modify an existing DLP rule (Set-DlpComplianceRule). Only supplied fields change. WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "Rule name or GUID to modify" },
        block_access: { type: "boolean", description: "Set the block-access action" },
        notify_user: { type: "array", items: { type: "string" }, description: "Replace the notify-user list" },
        generate_alert: { type: "boolean", description: "Set alert generation" },
        priority: { type: "integer", description: "Set rule priority" },
        disabled: { type: "boolean", description: "Enable (false) or disable (true) the rule" },
      },
    },
  },
  {
    name: "list_sensitive_information_types",
    description:
      "List Sensitive Information Types (SITs) visible to the tenant via Security & Compliance PowerShell: built-in Microsoft types and any custom types the org has created. Use this to find the exact SIT name needed by create_dlp_rule's sensitive_information_types parameter. Does not include trainable classifiers (a separate classification mechanism).",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "custom"],
          description: "Restrict to the org's custom (non-Microsoft) SITs only. Default: all.",
        },
      },
    },
  },
];

// ---- tool dispatch ---------------------------------------------------------

function text(t) {
  return { content: [{ type: "text", text: t }] };
}

async function dispatch(name, args) {
  switch (name) {
    case "list_sensitivity_labels":
      return text(labels.formatLabelList(await labels.listLabels()));

    case "get_sensitivity_label":
      return text(labels.formatLabelDetail(await labels.getLabel(args.label_id)));

    case "get_label_policy_settings":
      return text(labels.formatPolicySettings(await labels.getLabelPolicySettings()));

    case "list_dlp_policies":
      return text(dlp.formatPolicyList(await dlp.listPolicies()));

    case "get_dlp_policy":
      return text(dlp.formatPolicyDetail(await dlp.getPolicy(args.identity)));

    case "list_dlp_rules":
      return text(dlp.formatRuleList(await dlp.listRules(args.policy)));

    case "create_dlp_policy": {
      const params = { Name: args.name };
      if (args.mode) params.Mode = args.mode;
      if (args.comment) params.Comment = args.comment;
      if (args.exchange_location) params.ExchangeLocation = args.exchange_location;
      if (args.sharepoint_location) params.SharePointLocation = args.sharepoint_location;
      if (args.onedrive_location) params.OneDriveLocation = args.onedrive_location;
      return text(dlp.formatWriteResult("Create DLP policy", await dlp.createPolicy(params)));
    }

    case "set_dlp_policy": {
      const params = { Identity: args.identity };
      if (args.mode) params.Mode = args.mode;
      if (args.comment) params.Comment = args.comment;
      return text(dlp.formatWriteResult("Set DLP policy", await dlp.setPolicy(params)));
    }

    case "create_dlp_rule": {
      const params = { Name: args.name, Policy: args.policy };
      if (args.sensitive_information_types?.length) {
        params.ContentContainsSensitiveInformation = args.sensitive_information_types.map((n) => ({ Name: n }));
      }
      if (args.block_access != null) params.BlockAccess = args.block_access;
      if (args.notify_user?.length) params.NotifyUser = args.notify_user;
      if (args.generate_alert != null) params.GenerateAlert = args.generate_alert;
      if (args.priority != null) params.Priority = args.priority;
      return text(dlp.formatWriteResult("Create DLP rule", await dlp.createRule(params)));
    }

    case "set_dlp_rule": {
      const params = { Identity: args.identity };
      if (args.block_access != null) params.BlockAccess = args.block_access;
      if (args.notify_user?.length) params.NotifyUser = args.notify_user;
      if (args.generate_alert != null) params.GenerateAlert = args.generate_alert;
      if (args.priority != null) params.Priority = args.priority;
      if (args.disabled != null) params.Disabled = args.disabled;
      return text(dlp.formatWriteResult("Set DLP rule", await dlp.setRule(params)));
    }

    case "list_sensitive_information_types": {
      const scope = args.scope === "custom" ? "custom" : "all";
      return text(dlp.formatSitList(await dlp.listSensitiveInformationTypes(scope), scope));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- prompts ---------------------------------------------------------------

const PROMPTS = [
  {
    name: "dlp-policy-review",
    description:
      "Review the DLP posture of the tenant: enumerate policies and their rules, flag disabled rules, test-mode policies, and rules with no blocking action.",
    arguments: [],
  },
  {
    name: "label-coverage-audit",
    description:
      "Audit sensitivity labels and cross-reference them against DLP rules that key off sensitivity, highlighting labels not referenced by any DLP rule.",
    arguments: [],
  },
];

function promptMessage(t) {
  return { messages: [{ role: "user", content: { type: "text", text: t } }] };
}

function getPrompt(name) {
  switch (name) {
    case "dlp-policy-review":
      return {
        description: PROMPTS[0].description,
        ...promptMessage(
          `Review this tenant's Data Loss Prevention posture using the purview tools. Steps:
1. Call list_dlp_policies to enumerate all policies.
2. Call list_dlp_rules (no policy filter) to enumerate every rule.

Then produce a report with these sections:
**Summary** — total policies and rules; how many policies are in a Test mode vs Enable; how many rules are disabled.
**Coverage** — which workloads (Exchange/SharePoint/OneDrive/Teams/Endpoint) are covered, based on policy Workload values.
**Gaps & Risks** — call out: policies still in TestWithoutNotifications/TestWithNotifications, disabled rules, and rules that detect sensitive information but take no blocking action (BlockAccess not set).
**Recommendations** — a prioritised, concrete list of changes an admin should consider. Do not make any changes; this is read-only analysis.`
        ),
      };

    case "label-coverage-audit":
      return {
        description: PROMPTS[1].description,
        ...promptMessage(
          `Audit sensitivity-label usage across DLP using the purview tools. Steps:
1. Call list_sensitivity_labels to list all labels.
2. Call get_label_policy_settings to see mandatory-labeling and default-label configuration.
3. Call list_dlp_rules (no filter); note the sensitive information types / labels each rule references.

Then produce a report with these sections:
**Label Inventory** — labels grouped by sensitivity order, noting inactive labels.
**Policy Settings** — whether labeling is mandatory, whether downgrade justification is required, and the default label.
**Label ↔ DLP Linkage** — which labels are referenced by DLP rules and which are not referenced by any rule.
**Recommendations** — labels that may warrant DLP coverage, and any policy-setting hardening to consider. Read-only analysis; make no changes.`
        ),
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}

// ---- resources ---------------------------------------------------------

// Resources are user/host-attached context (as opposed to tools, which the
// model calls itself), so the same SIT catalog data is also exposed here for
// a user to attach directly when reasoning about the tenant's environment.
const RESOURCES = [
  {
    uri: "purview://sit-catalog",
    name: "Sensitive Information Types (all)",
    description:
      "All sensitive information types visible to the tenant — built-in Microsoft types and custom types the org has created. Does not include trainable classifiers.",
    mimeType: "text/markdown",
  },
  {
    uri: "purview://sit-catalog/custom",
    name: "Sensitive Information Types (custom only)",
    description: "Only the org's custom sensitive information types (Publisher other than Microsoft Corporation).",
    mimeType: "text/markdown",
  },
];

async function readResource(uri) {
  switch (uri) {
    case "purview://sit-catalog":
      return dlp.formatSitList(await dlp.listSensitiveInformationTypes("all"), "all");
    case "purview://sit-catalog/custom":
      return dlp.formatSitList(await dlp.listSensitiveInformationTypes("custom"), "custom");
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}

// ---- server wiring ---------------------------------------------------------

const server = new Server(
  { name: "str-mcp-purview", version: "1.0.0" },
  { capabilities: { tools: {}, prompts: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await dispatch(name, args ?? {});
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }));
server.setRequestHandler(GetPromptRequestSchema, async (request) => getPrompt(request.params.name));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  return { contents: [{ uri, mimeType: "text/markdown", text: await readResource(uri) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
