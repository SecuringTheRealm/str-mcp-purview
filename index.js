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

// Shared, category-grouped settings for the label write tools. Keeps the large
// New-/Set-Label surface organised (encryption, content marking, container and
// Teams protection) and avoids duplicating the schema across create and modify.
const LABEL_SETTINGS_PROPS = {
  display_name: { type: "string", description: "Display name shown to users" },
  tooltip: { type: "string", description: "Tooltip / description shown at classification time" },
  comment: { type: "string", description: "Admin comment" },
  encryption: {
    type: "object",
    description: "Encryption (rights-management) settings applied to labeled content.",
    properties: {
      enabled: { type: "boolean", description: "Turn encryption on/off" },
      protection_type: { type: "string", enum: ["Template", "RemoveProtection", "UserDefined"], description: "Protection model" },
      do_not_forward: { type: "boolean", description: "Apply the Do Not Forward protection" },
      encrypt_only: { type: "boolean", description: "Apply the Encrypt-Only protection" },
      offline_access_days: { type: "integer", description: "Days of offline access (-1 = unlimited, 0 = none)" },
      rights_definitions: {
        type: "array",
        description: "Per-identity usage rights.",
        items: {
          type: "object",
          required: ["identity", "rights"],
          properties: {
            identity: { type: "string", description: "User/group email, or 'AuthenticatedUsers'" },
            rights: { type: "array", items: { type: "string" }, description: "Rights, e.g. ['VIEW','EDIT','PRINT']" },
          },
        },
      },
    },
  },
  content_marking: {
    type: "object",
    description: "Visual markings (header, footer, watermark) stamped on labeled documents.",
    properties: {
      header: { type: "object", properties: {
        enabled: { type: "boolean" }, text: { type: "string" }, font_color: { type: "string", description: "Hex, e.g. #FF0000" },
        font_size: { type: "integer" }, alignment: { type: "string", enum: ["Left", "Center", "Right"] } } },
      footer: { type: "object", properties: {
        enabled: { type: "boolean" }, text: { type: "string" }, font_color: { type: "string" },
        font_size: { type: "integer" }, alignment: { type: "string", enum: ["Left", "Center", "Right"] } } },
      watermark: { type: "object", properties: {
        enabled: { type: "boolean" }, text: { type: "string" }, font_color: { type: "string" },
        font_size: { type: "integer" }, layout: { type: "string", enum: ["Horizontal", "Diagonal"] } } },
    },
  },
  site_and_group_protection: {
    type: "object",
    description: "Container protection for Microsoft 365 Groups, Teams, and SharePoint sites (Groups & sites label scope).",
    properties: {
      enabled: { type: "boolean" },
      privacy: { type: "string", enum: ["Public", "Private"] },
      allow_guest_access: { type: "boolean", description: "Allow guest users in the container" },
      external_sharing_control: { type: "string", enum: ["ExternalUserAndGuestSharing", "ExternalUserSharingOnly", "ExistingExternalUserSharingOnly", "Disabled"] },
      access_level: { type: "string", enum: ["FullAccess", "LimitedAccess", "BlockAccess"], description: "Access from unmanaged devices" },
    },
  },
  teams_protection: {
    type: "object",
    description: "Microsoft Teams meeting protection settings.",
    properties: {
      enabled: { type: "boolean" },
      allow_meeting_chat: { type: "string", enum: ["Enabled", "Disabled", "InMeetingOnly"] },
      allowed_presenters: { type: "string", enum: ["Everyone", "Organization", "Organizer", "OrganizerAndCoorganizers"] },
      end_to_end_encryption: { type: "boolean" },
      prevent_copy: { type: "boolean", description: "Prevent copying of meeting chat" },
    },
  },
};

const TOOLS = [
  {
    name: "list_sensitivity_labels",
    description:
      "List the Microsoft Purview Information Protection sensitivity labels available to the signed-in admin, via Microsoft Graph. One compact line per label. Optional filters narrow the list.",
    inputSchema: {
      type: "object",
      properties: {
        active: { type: "boolean", description: "Optional: only active (true) or inactive (false) labels." },
        parent: { type: "string", description: "Optional: only sub-labels of this parent label (name or GUID)." },
      },
    },
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
    name: "create_sensitivity_label",
    description:
      "Create a sensitivity label (New-Label) via Security & Compliance PowerShell. A created label does nothing until published with create_label_policy. WRITE operation — requires PowerShell 7+ and an IPPSSession sign-in.",
    inputSchema: {
      type: "object",
      required: ["name", "display_name", "tooltip"],
      properties: {
        name: { type: "string", description: "Unique internal label name" },
        parent_id: { type: "string", description: "Optional: parent label name/GUID to make this a sub-label" },
        ...LABEL_SETTINGS_PROPS,
      },
    },
  },
  {
    name: "set_sensitivity_label",
    description:
      "Modify an existing sensitivity label (Set-Label). Only supplied fields change. WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "Label name or GUID to modify" },
        ...LABEL_SETTINGS_PROPS,
      },
    },
  },
  {
    name: "create_label_policy",
    description:
      "Publish sensitivity labels to users by creating a label policy (New-LabelPolicy). Creation IS publishing — there is no separate publish step; changes replicate to clients automatically (can take up to ~24h). WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["name", "labels"],
      properties: {
        name: { type: "string", description: "Unique policy name" },
        labels: { type: "array", items: { type: "string" }, description: "Labels to publish (names or GUIDs)" },
        exchange_location: { type: "array", items: { type: "string" }, description: "Mailboxes to publish to, or ['All']" },
        modern_group_location: { type: "array", items: { type: "string" }, description: "Microsoft 365 Groups to publish to (SMTP addresses)" },
        advanced_settings: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Behaviour settings as key→value, e.g. {\"OutlookDefaultLabel\":\"General\",\"TeamworkMandatory\":\"True\"} (mandatory labeling, default label, etc.).",
        },
        comment: { type: "string", description: "Optional description/comment" },
      },
    },
  },
  {
    name: "set_label_policy",
    description:
      "Modify a label publishing policy (Set-LabelPolicy) — add/remove published labels or change behaviour settings. WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "Label policy name or GUID to modify" },
        add_labels: { type: "array", items: { type: "string" }, description: "Labels to add to the policy" },
        remove_labels: { type: "array", items: { type: "string" }, description: "Labels to remove from the policy" },
        advanced_settings: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Behaviour settings as key→value (mandatory labeling, default label, etc.).",
        },
        comment: { type: "string", description: "Optional description/comment" },
      },
    },
  },
  {
    name: "remove_sensitivity_label",
    description:
      "Delete a sensitivity label (Remove-Label). DESTRUCTIVE, irreversible WRITE operation. Review dependent policies first.",
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "Sensitivity label name or GUID to delete" },
      },
    },
  },
  {
    name: "remove_label_policy",
    description:
      "Delete a label publishing policy (Remove-LabelPolicy). Unpublishes its labels from users. DESTRUCTIVE, irreversible WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "Label policy name or GUID to delete" },
      },
    },
  },
  {
    name: "list_dlp_policies",
    description:
      "List Data Loss Prevention (DLP) policies in Microsoft Purview via Security & Compliance PowerShell. One compact line per policy. Optional filters narrow the list.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["Enable", "TestWithNotifications", "TestWithoutNotifications", "Disable"],
          description: "Optional: only policies in this exact mode.",
        },
        workload: { type: "string", description: "Optional: only policies whose workload contains this text (e.g. 'Endpoint', 'Exchange')." },
      },
    },
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
      "List DLP rules, optionally filtered to one policy and/or by state. Shows state, priority, block action, and detected sensitive information types.",
    inputSchema: {
      type: "object",
      properties: {
        policy: { type: "string", description: "Optional: restrict to rules in this DLP policy (name or GUID)" },
        disabled_only: { type: "boolean", description: "Optional: only disabled rules." },
        blocking_only: { type: "boolean", description: "Optional: only rules that block access." },
      },
    },
  },
  {
    name: "get_dlp_rule",
    description:
      "Get full DLP rule detail (Get-DlpComplianceRule): state, priority, parent policy, block action/scope, notified users, alert/severity, and detected sensitive information types. Provide EITHER identity (one rule) OR policy (full detail for every rule in that policy). Use list_dlp_rules first to find names.",
    inputSchema: {
      type: "object",
      properties: {
        identity: { type: "string", description: "A single DLP rule name or GUID — returns that one rule." },
        policy: { type: "string", description: "A DLP policy name or GUID — returns full detail for every rule in it. Use instead of identity." },
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
    name: "remove_dlp_policy",
    description:
      "Delete a DLP policy and all its rules (Remove-DlpCompliancePolicy). DESTRUCTIVE, irreversible WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "DLP policy name or GUID to delete" },
      },
    },
  },
  {
    name: "remove_dlp_rule",
    description:
      "Delete a single DLP rule (Remove-DlpComplianceRule). DESTRUCTIVE, irreversible WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "DLP rule name or GUID to delete" },
      },
    },
  },
  {
    name: "create_endpoint_dlp_policy",
    description:
      "Create a DLP policy scoped to Endpoint DLP — sensitive-data controls on users' onboarded devices, including inline enforcement in the Microsoft Edge browser (paste/upload to cloud & AI apps). Add device-activity restrictions with create_endpoint_dlp_rule. Requires devices onboarded to Microsoft Purview. WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Unique policy name" },
        endpoint_location: {
          type: "array",
          items: { type: "string" },
          description:
            "Users whose onboarded devices are in scope — email/name/GUID, or ['All'] (default). Endpoint DLP is scoped by user, not by mailbox or site.",
        },
        mode: {
          type: "string",
          enum: ["Enable", "TestWithNotifications", "TestWithoutNotifications", "Disable"],
          description: "Policy mode (default Enable). Prefer a Test mode first to see impact before blocking.",
        },
        comment: { type: "string", description: "Optional description/comment" },
      },
    },
  },
  {
    name: "create_endpoint_dlp_rule",
    description:
      "Create an Endpoint DLP rule (New-DlpComplianceRule with EndpointDlpRestrictions) inside an endpoint-scoped policy. Governs on-device activities — print, clipboard, USB, network share, and Microsoft Edge browser actions (paste to browser, upload to cloud/AI apps). WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["name", "policy", "endpoint_restrictions"],
      properties: {
        name: { type: "string", description: "Unique rule name" },
        policy: { type: "string", description: "Parent endpoint DLP policy name or GUID" },
        sensitive_information_types: {
          type: "array",
          items: { type: "string" },
          description: "Condition: sensitive information types to detect, e.g. ['Credit Card Number'].",
        },
        endpoint_restrictions: {
          type: "array",
          description:
            "Endpoint activities to govern. Each entry pairs an on-device activity with an action. Maps to EndpointDlpRestrictions.",
          items: {
            type: "object",
            required: ["activity", "action"],
            properties: {
              activity: {
                type: "string",
                enum: [
                  "Print",
                  "CopyToClipboard",
                  "RemovableMedia",
                  "NetworkShare",
                  "Bluetooth",
                  "RemoteDesktopServices",
                  "PasteToBrowser",
                  "ScreenCapture",
                ],
                description:
                  "On-device activity. PasteToBrowser governs pasting sensitive text into Microsoft Edge (e.g. AI-app prompts).",
              },
              action: {
                type: "string",
                enum: ["Audit", "Block", "Warn", "BlockWithOverride", "Ignore"],
                description: "Action for this activity. Not every action is valid for every activity — verify per activity.",
              },
            },
          },
        },
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
    name: "create_copilot_dlp_policy",
    description:
      "Create a DLP policy scoped to Microsoft 365 Copilot & Copilot Chat — controls what Copilot may process or ground responses on. Add rules with create_copilot_dlp_rule. WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Unique policy name" },
        user_scope: {
          type: "array",
          items: { type: "string" },
          description: "Users the policy applies to — email/GUID, or ['All'] (default).",
        },
        mode: {
          type: "string",
          enum: ["Enable", "TestWithNotifications", "TestWithoutNotifications", "Disable"],
          description: "Policy mode (default Enable). Prefer a Test mode first.",
        },
        comment: { type: "string", description: "Optional description/comment" },
      },
    },
  },
  {
    name: "create_copilot_dlp_rule",
    description:
      "Create a Microsoft 365 Copilot DLP rule inside a Copilot-scoped policy. Detects sensitive information types OR sensitivity labels (not both in one rule) and restricts Copilot from processing the content or from using external web grounding. WRITE operation.",
    inputSchema: {
      type: "object",
      required: ["name", "policy"],
      properties: {
        name: { type: "string", description: "Unique rule name" },
        policy: { type: "string", description: "Parent Copilot DLP policy name or GUID" },
        sensitive_information_types: {
          type: "array",
          items: { type: "string" },
          description: "Condition: SITs to detect in prompts/content, e.g. ['Credit Card Number']. Mutually exclusive with sensitivity_labels.",
        },
        sensitivity_labels: {
          type: "array",
          items: { type: "string" },
          description: "Condition: sensitivity-label GUIDs whose labeled files/emails Copilot must not process. Mutually exclusive with sensitive_information_types.",
        },
        action: {
          type: "string",
          enum: ["block_processing", "block_web_search"],
          description:
            "block_processing (default): Copilot won't process the matching content. block_web_search: Copilot won't use external web grounding for sensitive prompts (SIT condition only).",
        },
        notify_user: {
          type: "array",
          items: { type: "string" },
          description: "Action: notify these users (email addresses).",
        },
        priority: { type: "integer", description: "Rule priority (lower runs first)" },
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
        name_contains: { type: "string", description: "Optional: only SITs whose name contains this text (case-insensitive)." },
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
      return text(
        labels.formatLabelList(
          labels.filterLabels(await labels.listLabels(), { active: args.active, parent: args.parent })
        )
      );

    case "get_sensitivity_label":
      return text(labels.formatLabelDetail(await labels.getLabel(args.label_id)));

    case "get_label_policy_settings":
      return text(labels.formatPolicySettings(await labels.getLabelPolicySettings()));

    case "create_sensitivity_label": {
      const params = { Name: args.name, ...labels.labelSettingsParams(args) };
      if (args.parent_id) params.ParentId = args.parent_id;
      return text(labels.formatWriteResult("Create sensitivity label", await labels.createLabel(params)));
    }

    case "set_sensitivity_label": {
      const params = { Identity: args.identity, ...labels.labelSettingsParams(args) };
      return text(labels.formatWriteResult("Set sensitivity label", await labels.setLabel(params)));
    }

    case "create_label_policy": {
      const params = { Name: args.name, Labels: args.labels };
      if (args.exchange_location?.length) params.ExchangeLocation = args.exchange_location;
      if (args.modern_group_location?.length) params.ModernGroupLocation = args.modern_group_location;
      if (args.advanced_settings) params.AdvancedSettings = args.advanced_settings;
      if (args.comment) params.Comment = args.comment;
      return text(labels.formatWriteResult("Create label policy", await labels.createLabelPolicy(params)));
    }

    case "set_label_policy": {
      const params = { Identity: args.identity };
      if (args.add_labels?.length) params.AddLabels = args.add_labels;
      if (args.remove_labels?.length) params.RemoveLabels = args.remove_labels;
      if (args.advanced_settings) params.AdvancedSettings = args.advanced_settings;
      if (args.comment) params.Comment = args.comment;
      return text(labels.formatWriteResult("Set label policy", await labels.setLabelPolicy(params)));
    }

    case "remove_sensitivity_label":
      await labels.removeLabel({ Identity: args.identity, Confirm: false });
      return text(`Deleted sensitivity label: ${args.identity}`);

    case "remove_label_policy":
      await labels.removeLabelPolicy({ Identity: args.identity, Confirm: false });
      return text(`Deleted label policy: ${args.identity}`);

    case "list_dlp_policies":
      return text(
        dlp.formatPolicyList(dlp.filterPolicies(await dlp.listPolicies(), { mode: args.mode, workload: args.workload }))
      );

    case "get_dlp_policy":
      return text(dlp.formatPolicyDetail(await dlp.getPolicy(args.identity)));

    case "list_dlp_rules":
      return text(
        dlp.formatRuleList(
          dlp.filterRules(await dlp.listRules(args.policy), { disabledOnly: args.disabled_only, blockingOnly: args.blocking_only })
        )
      );

    case "get_dlp_rule": {
      if (args.identity) return text(dlp.formatRuleDetail(await dlp.getRule(args.identity)));
      if (args.policy) return text(dlp.formatRuleDetails(await dlp.listRules(args.policy), args.policy));
      throw new Error("get_dlp_rule requires either 'identity' (one rule) or 'policy' (all rules in a policy).");
    }

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

    case "remove_dlp_policy":
      await dlp.removePolicy({ Identity: args.identity, Confirm: false });
      return text(`Deleted DLP policy: ${args.identity}`);

    case "remove_dlp_rule":
      await dlp.removeRule({ Identity: args.identity, Confirm: false });
      return text(`Deleted DLP rule: ${args.identity}`);

    case "create_endpoint_dlp_policy": {
      const params = {
        Name: args.name,
        EndpointDlpLocation: args.endpoint_location?.length ? args.endpoint_location : ["All"],
      };
      if (args.mode) params.Mode = args.mode;
      if (args.comment) params.Comment = args.comment;
      return text(dlp.formatWriteResult("Create endpoint DLP policy", await dlp.createPolicy(params)));
    }

    case "create_endpoint_dlp_rule": {
      const params = { Name: args.name, Policy: args.policy };
      if (args.sensitive_information_types?.length) {
        params.ContentContainsSensitiveInformation = args.sensitive_information_types.map((n) => ({ Name: n }));
      }
      if (args.endpoint_restrictions?.length) {
        params.EndpointDlpRestrictions = args.endpoint_restrictions.map((r) => ({ Setting: r.activity, Value: r.action }));
      }
      if (args.notify_user?.length) params.NotifyUser = args.notify_user;
      if (args.generate_alert != null) params.GenerateAlert = args.generate_alert;
      if (args.priority != null) params.Priority = args.priority;
      return text(dlp.formatWriteResult("Create endpoint DLP rule", await dlp.createRule(params)));
    }

    case "create_copilot_dlp_policy": {
      const params = {
        Name: args.name,
        Locations: dlp.copilotLocations(args.user_scope),
        EnforcementPlanes: ["CopilotExperiences"],
      };
      if (args.mode) params.Mode = args.mode;
      if (args.comment) params.Comment = args.comment;
      return text(dlp.formatWriteResult("Create Copilot DLP policy", await dlp.createPolicy(params)));
    }

    case "create_copilot_dlp_rule": {
      const params = {
        Name: args.name,
        Policy: args.policy,
        ContentContainsSensitiveInformation: dlp.copilotCondition({
          sits: args.sensitive_information_types,
          labels: args.sensitivity_labels,
        }),
      };
      if (args.action === "block_web_search") params.RestrictWebGrounding = true;
      else params.RestrictAccess = [{ setting: "ExcludeContentProcessing", value: "Block" }];
      if (args.notify_user?.length) params.NotifyUser = args.notify_user;
      if (args.priority != null) params.Priority = args.priority;
      return text(dlp.formatWriteResult("Create Copilot DLP rule", await dlp.createRule(params)));
    }

    case "list_sensitive_information_types": {
      const scope = args.scope === "custom" ? "custom" : "all";
      return text(dlp.formatSitList(await dlp.listSensitiveInformationTypes(scope, args.name_contains), scope));
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---- prompts ---------------------------------------------------------------

const PROMPTS = [
  {
    name: "dlp-control-review",
    description:
      "Deep-dive audit of DLP control quality — whether policies/rules are well-built, non-conflicting, correctly scoped, alerted, and enforce-ready. Classifies findings as Effectiveness (data not protected) or Hygiene, never by severity. Complements data-security-posture. Read-only.",
    arguments: [
      { name: "policy", description: "Optional: focus the review on a single DLP policy (name or GUID).", required: false },
    ],
  },
  {
    name: "data-security-posture",
    description:
      "Assess the tenant's data-security posture by tracing whether classifications (SITs, labels) translate into ENFORCED controls. Ranks gaps by where the protection chain breaks and recommends fixes. Read-only.",
    arguments: [
      {
        name: "business_context",
        description:
          "Optional: the org's industry, jurisdictions, regulatory obligations, and sensitive data handled — used to judge which protections should exist.",
        required: false,
      },
    ],
  },
];

function promptMessage(t) {
  return { messages: [{ role: "user", content: { type: "text", text: t } }] };
}

function getPrompt(name, args = {}) {
  const meta = PROMPTS.find((p) => p.name === name);
  switch (name) {
    case "data-security-posture": {
      const providedContext = args?.business_context
        ? `\n\n**Business context provided by the practitioner:** ${args.business_context}\nTreat this as authoritative for the Step 1 judgment (basis: [from stated context]).`
        : "";
      return {
        description: meta.description,
        ...promptMessage(
          `Assess this Microsoft Purview tenant's DATA-SECURITY POSTURE by tracing whether classifications translate into ENFORCED controls. This is read-only analysis — make no changes.${providedContext}

## Step 1 — Establish business context first
The "should you be protecting X?" judgment needs business context this tool does not have. In order:
1. If business context was provided (above or from the wider workflow — industry, jurisdictions, regulatory obligations, sensitive data handled), use it.
2. Otherwise, briefly ASK the practitioner for it.
3. If still unavailable, INFER a profile hypothesis from the deployment's own signals — label names, custom SIT names, the built-in SITs already used in policies, policy names/comments, and covered workloads (e.g. "EU org handling financial + health data"). State it explicitly as a hypothesis to confirm.
Tag every recommendation later with its basis: **[from stated context]** or **[inferred — confirm]**.

## Step 2 — Gather evidence (bounded — do NOT enumerate all built-in SITs)
Call: list_dlp_policies, list_dlp_rules (no filter), list_sensitivity_labels, get_label_policy_settings, and list_sensitive_information_types with scope "custom" ONLY.
Do not list all SITs — the 280+ built-ins are noise. The only built-in SITs that matter are those actually referenced by rules; read those from the rules. Use get_dlp_policy / get_dlp_rule / get_sensitivity_label for detail on specific flagged items only.

## Step 3 — Trace the protection chain
For each classification primitive walk: DEFINE → REFERENCE (used by a policy) → ENFORCE (policy mode Enable, rule enabled, blocking action set) → COVER (workloads/scope). Direction depends on whether the org opted in:
- CUSTOM SITs and LABELS (org-created): start from the catalog — an item referenced by NO enforced policy is a real gap; they built it to be used.
- BUILT-IN SITs: consider only those referenced by rules; never treat an unused built-in as a gap.
- LABELS have two protection paths — their own encryption OR an enforced DLP rule that references them. A label not published by any label policy breaks at the first link (it cannot even be applied).

## Step 4 — Report
**Business context & profile** — what you established, with provenance.
**Posture summary** — headline: how much of the org's classification reaches an enforced control; counts of policies, labels, custom SITs.
**Findings — grouped by where the chain breaks, NOT by severity.** An **Effectiveness** gap means classification does not reach enforced protection; a **Hygiene** issue is quality, not protection. Tag each **[config]** (fact) or **[assessment]** (judgement).
- **Not enforced** (reference→enforce) — references sensitive data but sits in a Test mode or is disabled. You cannot measure time-in-test (no mode-change history): show WhenCreated + WhenChangedUTC and treat a test policy as *stalled* only when age suggests it — a recent or just-created policy is in-progress, not a finding. [Effectiveness]
- **Not controlled** (define→reference) — custom SITs or labels not enforced by any policy; published labels with neither encryption nor a DLP reference. [Effectiveness]
- **Partially enforced** (enforce→cover) — enforced but narrow scope, missing workloads, or detect-without-block. [Effectiveness]
- **Hygiene** — weak governance (mandatory-labeling off, no default label) or taxonomy smells: quality, not protection.
- **Context-driven** — protections expected given the business profile but absent (each with a [basis] tag).
**Prioritised recommendations** — concrete next steps, each naming the tool to use (e.g. set_dlp_policy to promote to enforce, create_dlp_rule to cover a SIT, create_label_policy to publish an orphaned label) and its [basis] tag. Do not perform them — this is analysis only.`
        ),
      };
    }

    case "dlp-control-review": {
      const scopeNote = args?.policy
        ? `\n\n**Scope:** review only the DLP policy "${args.policy}" — use get_dlp_policy for it and list_dlp_rules with policy set to it.`
        : "";
      return {
        description: meta.description,
        ...promptMessage(
          `Deep-dive audit of this tenant's DLP CONTROLS — whether they are well-built, non-conflicting, correctly scoped, properly alerted, and ready to enforce. Read-only — make no changes.${scopeNote}

This complements data-security-posture: that prompt asks "does classification reach enforcement?" (breadth); this asks "are the DLP controls themselves well-built and enforce-ready?" (depth). Do not re-derive the classification-coverage chain here — defer that to data-security-posture.

## Step 1 — Gather evidence (bounded)
Call list_dlp_policies and list_dlp_rules. Then call get_dlp_policy / get_dlp_rule ONLY on items you flag (test-mode, over-broad, broad high-priority rules, heavy-block) to pull their locations and exceptions — the detail reads carry those; the list reads do not. Do not drill into every item.

## Step 2 — Assess. Classify each finding two independent ways:
- CLASS — **Effectiveness** (the control does not actually protect — data slips through) or **Hygiene** (it works but is sub-optimal / hard to maintain).
- BASIS — **[config]** (a fact read from settings) or **[assessment]** (your judgement — state the reasoning).
Do NOT assign risk severities — the practitioner applies their own risk lens.

Assess:
**Enforcement readiness**
- Stalled test-mode policy — in a Test mode and apparently not progressing to enforcement. You CANNOT measure time-in-test (no mode-change history); use WhenCreated + WhenChangedUTC as a proxy and ALWAYS show both dates. A recently created/changed policy — or one created earlier in this conversation — is in-progress, NOT a finding. [Effectiveness, assessment]
- Promotion-ready — a well-formed test policy (rules + actions + notifications) that looks ready; recommend set_dlp_policy to promote IF intended. [Effectiveness, assessment]
- Disabled rule inside an enabled policy — dead logic. [Effectiveness, config]
**Correctness & conflicts**
- Priority shadowing — a broad, high-priority rule (few conditions, or StopPolicyProcessing) ahead of more specific lower-priority rules that may then never fire. [Effectiveness, assessment]
- Monitor-only — detects SITs/labels but sets no BlockAccess/RestrictAccess (matches are logged only; may be intentional — say so). [Effectiveness, assessment]
- Block-without-notify — blocks but no NotifyUser/policy tip (users get no explanation). [Hygiene, config]
**Scope & targeting** (use the enriched get_dlp_policy Locations)
- Over-broad — All-locations with a hard block (disruption risk). [Effectiveness, assessment]
- Workload gap — a data type protected in one workload (e.g. Exchange) but not others where it flows (Endpoint/Teams/Copilot). [Effectiveness, config+assessment]
- Heavy exceptions — many ExceptIf* conditions that may quietly defeat the rule. [Effectiveness, assessment]
- Overlapping policies on the same workload — precedence confusion. [Hygiene, config]
**Alerting & hygiene**
- Blind enforcement — a blocking rule with GenerateAlert unset. [Hygiene, config]
- Severity mismatch — high-impact rule with no/low ReportSeverityLevel. [Hygiene, config]
- Undocumented policy — no Comment. [Hygiene, config]
- Duplicate rules — same SITs + actions across policies. [Hygiene, assessment]

## Step 3 — Report
**Scope** — tenant-wide, or the single policy reviewed.
**Enforcement summary** — mode distribution (enforce vs test vs disabled); note any promotion-ready.
**Effectiveness findings** (first) — each states the concrete consequence factually (e.g. "detects credit-card numbers but takes no action — matches are logged only"), with its [basis]; for test-mode items include the WhenCreated / WhenChangedUTC dates.
**Hygiene findings** (second).
Within each group, present findings — do NOT rank them.
**Recommendations** — concrete next steps, each naming the tool (set_dlp_policy to promote/change mode, set_dlp_rule to enable/add a block or notification, remove_dlp_rule for dead duplicates) and its [basis]. Do not perform them — analysis only.`
        ),
      };
    }

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
    uri: "purview://label-catalog",
    name: "Sensitivity Labels",
    description:
      "All Microsoft Purview Information Protection sensitivity labels visible to the signed-in admin — the classification vocabulary, attachable as context when reasoning about labels and DLP coverage.",
    mimeType: "text/markdown",
  },
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
    case "purview://label-catalog":
      return labels.formatLabelList(await labels.listLabels());
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
server.setRequestHandler(GetPromptRequestSchema, async (request) => getPrompt(request.params.name, request.params.arguments));

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  return { contents: [{ uri, mimeType: "text/markdown", text: await readResource(uri) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
