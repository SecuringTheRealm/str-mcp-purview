const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const DESTROY = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const CONFIRM_DELETE = {
  type: "boolean",
  const: true,
  description: "Deprecated compatibility argument. Does not authorize deletion; the server always requires form elicitation confirmation.",
};

const STRING_LIST = (description) => ({
  type: "array",
  items: { type: "string", minLength: 1 },
  description,
});
const ALERT_RECIPIENTS = {
  type: "array", minItems: 1, uniqueItems: true,
  items: { type: "string", pattern: "^(SiteAdmin|[^\\s@]+@[^\\s@]+)$" },
  description: "Alert recipients: email addresses or SiteAdmin. Booleans are not valid; no recipient is inferred.",
};

const SIT_CONDITION_ITEM = {
  oneOf: [
    { type: "string", minLength: 1 },
    {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", minLength: 1, description: "Sensitive information type name" },
        min_count: { type: "integer", minimum: 1, description: "Minimum matches required" },
        max_count: {
          oneOf: [{ const: -1 }, { type: "integer", minimum: 1 }],
          description: "Maximum matches allowed; -1 means unlimited",
        },
        confidence_level: {
          type: "string",
          enum: ["Low", "Medium", "High"],
          description: "Minimum Purview confidence level for this SIT match",
        },
      },
    },
  ],
};

const SENSITIVE_INFORMATION_TYPES = {
  type: "array",
  minItems: 1,
  items: SIT_CONDITION_ITEM,
  description:
    "SIT conditions. Each item can be a name string or {name, min_count?, max_count?, confidence_level?} for per-SIT tuning.",
};

const RULE_EXCEPTIONS = {
  type: "object",
  description: "Exceptions that prevent the rule from applying when any configured exception matches.",
  properties: {
    sensitive_information_types: {
      type: "array",
      minItems: 1,
      items: SIT_CONDITION_ITEM,
      description: "Except when content contains these SITs.",
    },
    content_property_contains_words: { ...STRING_LIST("Property:value1,value2 entries, e.g. Author:Alice,Bob."), items: { type: "string", pattern: "^[^:]+:.+$" } },
    document_name_matches_words: STRING_LIST("Except when the document name contains these words."),
    document_name_matches_patterns: STRING_LIST("Except when the document name matches these regex patterns."),
    document_matches_patterns: STRING_LIST("Except when document content matches these regex patterns."),
    content_extension_matches_words: STRING_LIST("Except for these file extensions."),
    from: STRING_LIST("Except for these sender email addresses. Requires an Exchange-only parent policy."),
    from_member_of: STRING_LIST("Except for senders in these groups."),
    sent_to: STRING_LIST("Except for these recipient email addresses. Requires an Exchange-only parent policy."),
    recipient_domain_is: STRING_LIST("Except for these recipient domains."),
    sender_domain_is: STRING_LIST("Except for these sender domains."),
  },
};

const DLP_RULE_ENRICHMENT_PROPS = {
  sensitive_information_types: SENSITIVE_INFORMATION_TYPES,
  access_scope: {
    type: "string",
    enum: ["InOrganization", "NotInOrganization", "None"],
    description: "Apply based on whether content is accessible/delivered inside or outside the organisation; None clears it.",
  },
  report_severity_level: {
    type: "string",
    enum: ["None", "Low", "Medium", "High"],
    description: "Severity assigned to detections and incident reporting; does not change enforcement.",
  },
  notification_email_subject: {
    type: "string",
    description: "Custom subject for user notification emails (NotifyEmailCustomSubject).",
  },
  notification_email_body: {
    type: "string",
    maxLength: 5000,
    description: "Custom body for user notification emails; supports Purview tokens and limited HTML.",
  },
  policy_tip_text: {
    type: "string",
    maxLength: 256,
    description: "Plain-text custom policy tip shown to users; HTML and tokens are not supported.",
  },
  exceptions: RULE_EXCEPTIONS,
};

const POLICY_LOCATION_EXCEPTION_PROPS = {
  sharepoint: STRING_LIST("SharePoint site URLs to exclude."),
  onedrive: STRING_LIST("OneDrive accounts to exclude."),
  teams: STRING_LIST("Teams users/accounts to exclude."),
  endpoint: STRING_LIST("Users whose onboarded devices should be excluded."),
};

// Shared, category-grouped settings for the label write tools. Keeps the large
// New-/Set-Label surface organised (encryption, content marking, container and
// Teams protection) and avoids duplicating the schema across create and modify.
const LABEL_SETTINGS_PROPS = {
  display_name: { type: "string", description: "Display name shown to users" },
  tooltip: { type: "string", description: "Tooltip / description shown at classification time" },
  comment: { type: "string", description: "Admin comment" },
  color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$", description: "Label or group colour as a six-digit RGB hex code." },
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
      "List Microsoft Purview sensitivity labels from Security & Compliance PowerShell, including each label's GUID, immutable SCC name, and display name. Optional filters narrow the list.",
    annotations: { title: "List sensitivity labels", ...READ },
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
      "Get a sensitivity label directly from Security & Compliance PowerShell by name or GUID, including its immutable SCC identity and protection configuration. This is immediately consistent with create_sensitivity_label/set_sensitivity_label.",
    annotations: { title: "Get sensitivity label", ...READ },
    inputSchema: {
      type: "object",
      required: ["label_id"],
      properties: {
        label_id: { type: "string", description: "Sensitivity label SCC name or GUID, from list_sensitivity_labels" },
        include_protection_settings: {
          type: "boolean",
          description: "Deprecated compatibility flag; protection configuration is now always returned.",
        },
      },
    },
  },
  {
    name: "get_label_policy_settings",
    description:
      "Get the Information Protection label policy settings for the signed-in admin (mandatory labeling, downgrade justification, default label).",
    annotations: { title: "Get label policy settings", ...READ },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_label_policies",
    description:
      "List the label publishing policies — which sensitivity labels are published to which users/groups, and each policy's state. One compact line per policy. Use get_label_policy for full detail.",
    annotations: { title: "List label publishing policies", ...READ },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_label_policy",
    description:
      "Get one label publishing policy in full — the labels it publishes, its target locations, and its behaviour settings (mandatory labeling, default label). The read-back for create_label_policy/set_label_policy.",
    annotations: { title: "Get label publishing policy", ...READ },
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "Label policy name or GUID" },
      },
    },
  },
  {
    name: "create_sensitivity_label",
    description:
      "Create a sensitivity label or an organisational label group (New-Label). Modern-scheme sub-labels require a label group as their parent. Groups cannot carry protection settings. A created label does nothing until published with create_label_policy. WRITE operation — changes tenant configuration.",
    annotations: { title: "Create sensitivity label", ...CREATE },
    inputSchema: {
      type: "object",
      required: ["name", "display_name"],
      if: { properties: { is_label_group: { const: true } }, required: ["is_label_group"] },
      then: { not: { anyOf: ["parent_id", "encryption", "content_marking", "site_and_group_protection", "teams_protection"].map((key) => ({ required: [key] })) } },
      else: { required: ["tooltip"] },
      properties: {
        name: { type: "string", description: "Unique internal label name" },
        is_label_group: { type: "boolean", description: "Create an organisational label group for modern-scheme sub-labels. Only name/display name, descriptions and colour are accepted; tooltip is optional. Cannot have a parent or protection settings." },
        parent_id: { type: "string", description: "Optional: parent name/GUID for a sub-label. Modern-scheme tenants require an existing label group; create one with is_label_group:true. Classic tenants can use an ordinary parent label." },
        ...LABEL_SETTINGS_PROPS,
      },
    },
  },
  {
    name: "set_sensitivity_label",
    description:
      "Modify an existing sensitivity label (Set-Label). Only supplied fields change. WRITE operation.",
    annotations: { title: "Modify sensitivity label", ...UPDATE },
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
    annotations: { title: "Publish labels (create policy)", ...CREATE },
    inputSchema: {
      type: "object",
      description: "Provide at least one nonempty exchange_location or modern_group_location target to publish labels.",
      required: ["name", "labels"],
      anyOf: [
        { required: ["exchange_location"], properties: { exchange_location: { minItems: 1 } } },
        { required: ["modern_group_location"], properties: { modern_group_location: { minItems: 1 } } },
      ],
      properties: {
        name: { type: "string", description: "Unique policy name" },
        labels: { ...STRING_LIST("Labels to publish (names or GUIDs)"), minItems: 1 },
        exchange_location: { ...STRING_LIST("Mailboxes to publish to, or ['All']. At least one nonempty Exchange or Microsoft 365 Groups target is required."), items: { type: "string", pattern: "\\S" } },
        modern_group_location: { ...STRING_LIST("Microsoft 365 Groups to publish to (SMTP addresses). At least one nonempty Exchange or Microsoft 365 Groups target is required."), items: { type: "string", pattern: "\\S" } },
        advanced_settings: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Behaviour settings as key→value; ALL values are strings (booleans as \"True\"/\"False\"). Common keys: Mandatory (require a label), DefaultLabelId (label GUID applied by default), OutlookDefaultLabel, TeamworkMandatory, RequireDowngradeJustification. E.g. {\"Mandatory\":\"True\",\"DefaultLabelId\":\"<guid>\"}.",
        },
        comment: { type: "string", description: "Optional description/comment" },
      },
    },
  },
  {
    name: "set_label_policy",
    description:
      "Modify a label publishing policy (Set-LabelPolicy) — add/remove published labels or change behaviour settings. WRITE operation.",
    annotations: { title: "Modify label publishing policy", ...UPDATE },
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
          description:
            "Behaviour settings as key→value; ALL values are strings (booleans as \"True\"/\"False\"). Common keys: Mandatory, DefaultLabelId, OutlookDefaultLabel, TeamworkMandatory, RequireDowngradeJustification.",
        },
        comment: { type: "string", description: "Optional description/comment" },
      },
    },
  },
  {
    name: "remove_sensitivity_label",
    description:
      "Delete a sensitivity label (Remove-Label). DESTRUCTIVE, irreversible WRITE operation. Review dependent policies first.",
    annotations: { title: "Delete sensitivity label", ...DESTROY },
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "Sensitivity label name or GUID to delete" },
        confirm: CONFIRM_DELETE,
      },
    },
  },
  {
    name: "remove_label_policy",
    description:
      "Delete a label publishing policy (Remove-LabelPolicy). Unpublishes its labels from users. DESTRUCTIVE, irreversible WRITE operation.",
    annotations: { title: "Delete label publishing policy", ...DESTROY },
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "Label policy name or GUID to delete" },
        confirm: CONFIRM_DELETE,
      },
    },
  },
  {
    name: "list_dlp_policies",
    description:
      "List Data Loss Prevention (DLP) policies in Microsoft Purview. One compact line per policy. Optional filters narrow the list.",
    annotations: { title: "List DLP policies", ...READ },
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
    description:
      "Get details of a single DLP policy by name or GUID, including its per-workload locations and exclusions. Set include_distribution_detail to also fetch the per-location distribution/sync status — use this to diagnose a policy stuck or reporting a sync failure in the portal.",
    annotations: { title: "Get DLP policy", ...READ },
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "DLP policy name or GUID" },
        include_distribution_detail: {
          type: "boolean",
          description:
            "Also fetch per-location distribution/sync status and results (Get-DlpCompliancePolicy -DistributionDetail). Slower; use when a policy shows a sync problem.",
        },
      },
    },
  },
  {
    name: "list_dlp_rules",
    description:
      "List DLP rules, optionally filtered to one policy and/or by state. Shows state, priority, block action, and detected sensitive information types or labels.",
    annotations: { title: "List DLP rules", ...READ },
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
      "Get full DLP rule detail (Get-DlpComplianceRule): state, priority, parent policy, block action/scope, notified users, alert/severity, exceptions, and detected sensitive information types or labels. Provide EITHER identity (one rule) OR policy (paginated full detail for rules in that policy). Use list_dlp_rules first to find names.",
    annotations: { title: "Get DLP rule detail", ...READ },
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
      "Create a new DLP policy (New-DlpCompliancePolicy), including supported SharePoint, OneDrive, and Teams location exclusions. Creates the container; add rules with create_dlp_rule. WRITE operation — this changes tenant configuration.",
    annotations: { title: "Create DLP policy", ...CREATE },
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
          description: "['All'] or user UPNs (not site URLs). User scopes map to OneDriveSharedBy; cannot combine user inclusions and exclusions.",
        },
        teams_location: {
          type: "array",
          items: { type: "string" },
          description: "Teams chat/channel message locations, e.g. ['All'].",
        },
        location_exceptions: {
          type: "object",
          description: "Locations to exclude from an otherwise included workload scope.",
          properties: {
            sharepoint: POLICY_LOCATION_EXCEPTION_PROPS.sharepoint,
            onedrive: POLICY_LOCATION_EXCEPTION_PROPS.onedrive,
            teams: POLICY_LOCATION_EXCEPTION_PROPS.teams,
          },
        },
      },
    },
  },
  {
    name: "set_dlp_policy",
    description:
      "Modify an existing DLP policy (Set-DlpCompliancePolicy): change mode, add/remove protected locations, or add/remove supported location exclusions. Only supplied fields change. WRITE operation — this changes tenant configuration.",
    annotations: { title: "Modify DLP policy", ...UPDATE },
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
        add_locations: {
          type: "object",
          description: "Locations to add to the policy's scope, per workload.",
          properties: {
            exchange: { type: "array", items: { type: "string" }, description: "Mailboxes, or ['All']" },
            sharepoint: { type: "array", items: { type: "string" }, description: "SharePoint site URLs, or ['All']" },
            onedrive: { type: "array", items: { type: "string" }, description: "OneDrive accounts, or ['All']" },
            teams: { type: "array", items: { type: "string" }, description: "Teams accounts, or ['All']" },
            endpoint: { type: "array", items: { type: "string" }, description: "Users whose onboarded devices are in scope, or ['All']" },
          },
        },
        remove_locations: {
          type: "object",
          description: "Locations to remove from the policy's scope, per workload.",
          properties: {
            exchange: { type: "array", items: { type: "string" }, description: "Mailboxes, or ['All']" },
            sharepoint: { type: "array", items: { type: "string" }, description: "SharePoint site URLs, or ['All']" },
            onedrive: { type: "array", items: { type: "string" }, description: "OneDrive accounts, or ['All']" },
            teams: { type: "array", items: { type: "string" }, description: "Teams accounts, or ['All']" },
            endpoint: { type: "array", items: { type: "string" }, description: "Users, or ['All']" },
          },
        },
        add_location_exceptions: {
          type: "object",
          description: "Add exclusions to the policy, per supported workload.",
          properties: POLICY_LOCATION_EXCEPTION_PROPS,
        },
        remove_location_exceptions: {
          type: "object",
          description: "Remove existing exclusions from the policy, per supported workload.",
          properties: POLICY_LOCATION_EXCEPTION_PROPS,
        },
      },
    },
  },
  {
    name: "create_dlp_rule",
    description:
      "Create a DLP rule inside a policy (New-DlpComplianceRule), with optional per-SIT tuning, access scope, severity, custom notifications, and common exceptions. A rule needs at least one condition and one action. WRITE operation.",
    annotations: { title: "Create DLP rule", ...CREATE },
    inputSchema: {
      type: "object",
      required: ["name", "policy"],
      properties: {
        name: { type: "string", description: "Unique rule name" },
        policy: { type: "string", description: "Parent DLP policy name or GUID" },
        ...DLP_RULE_ENRICHMENT_PROPS,
        block_access: { type: "boolean", description: "Action: block access to matching content" },
        notify_user: {
          type: "array",
          items: { type: "string" },
          description: "Action: notify these users (email addresses, or ['LastModifier','Owner']).",
        },
        generate_alert: ALERT_RECIPIENTS,
        priority: { type: "integer", description: "Rule priority (lower runs first)" },
      },
    },
  },
  {
    name: "set_dlp_rule",
    description:
      "Modify an existing DLP rule (Set-DlpComplianceRule) — traditional, endpoint, or Copilot — including per-SIT tuning, access scope, severity, custom notifications, and common exceptions. Only supplied fields change. WRITE operation.",
    annotations: { title: "Modify DLP rule", ...UPDATE },
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "Rule name or GUID to modify" },
        ...DLP_RULE_ENRICHMENT_PROPS,
        block_access: { type: "boolean", description: "Set the block-access action" },
        notify_user: { type: "array", items: { type: "string" }, description: "Replace the notify-user list" },
        generate_alert: ALERT_RECIPIENTS,
        priority: { type: "integer", description: "Set rule priority" },
        disabled: { type: "boolean", description: "Enable (false) or disable (true) the rule" },
        endpoint_restrictions: {
          type: "array",
          description:
            "Endpoint rules only: replace the on-device activity restrictions. Block/Warn actions require notify_user.",
          items: {
            type: "object",
            required: ["activity", "action"],
            properties: {
              activity: {
                type: "string",
                enum: ["Print", "CopyPaste", "ScreenCapture", "RemovableMedia", "NetworkShare"],
                description: "On-device activity (documented EndpointDlpRestrictions setting).",
              },
              action: {
                type: "string",
                enum: ["Audit", "Block", "Warn", "Ignore"],
                description: "Action for this activity.",
              },
            },
          },
        },
      },
    },
  },
  {
    name: "remove_dlp_policy",
    description:
      "Delete a DLP policy and all its rules (Remove-DlpCompliancePolicy). DESTRUCTIVE, irreversible WRITE operation.",
    annotations: { title: "Delete DLP policy", ...DESTROY },
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "DLP policy name or GUID to delete" },
        confirm: CONFIRM_DELETE,
      },
    },
  },
  {
    name: "remove_dlp_rule",
    description:
      "Delete a single DLP rule (Remove-DlpComplianceRule). DESTRUCTIVE, irreversible WRITE operation.",
    annotations: { title: "Delete DLP rule", ...DESTROY },
    inputSchema: {
      type: "object",
      required: ["identity"],
      properties: {
        identity: { type: "string", description: "DLP rule name or GUID to delete" },
        confirm: CONFIRM_DELETE,
      },
    },
  },
  {
    name: "create_endpoint_dlp_policy",
    description:
      "Create a DLP policy scoped to Endpoint DLP — sensitive-data controls on users' onboarded devices. Add device-activity restrictions with create_endpoint_dlp_rule. Requires devices onboarded to Microsoft Purview. WRITE operation.",
    annotations: { title: "Create endpoint DLP policy", ...CREATE },
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
        endpoint_location_exception: STRING_LIST("Users whose onboarded devices should be excluded from this endpoint policy."),
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
      "Create an Endpoint DLP rule (New-DlpComplianceRule with EndpointDlpRestrictions) inside an endpoint-scoped policy. Governs the documented on-device activities: print, copy/paste to clipboard, screen capture, removable media (USB), and network share. Restricting paste/upload into specific browsers or AI sites additionally requires sensitive-service-domain groups, configured in the Purview portal (not exposed here). WRITE operation.",
    annotations: { title: "Create endpoint DLP rule", ...CREATE },
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
            "Endpoint activities to govern. Each entry pairs an on-device activity with an action. Maps to EndpointDlpRestrictions. Block/Warn actions require notify_user.",
          items: {
            type: "object",
            required: ["activity", "action"],
            properties: {
              activity: {
                type: "string",
                enum: ["Print", "CopyPaste", "ScreenCapture", "RemovableMedia", "NetworkShare"],
                description: "On-device activity (documented EndpointDlpRestrictions setting).",
              },
              action: {
                type: "string",
                enum: ["Audit", "Block", "Warn", "Ignore"],
                description: "Action for this activity.",
              },
            },
          },
        },
        notify_user: {
          type: "array",
          items: { type: "string" },
          description: "Notify these users (email addresses, or ['LastModifier','Owner']). Required when any restriction uses Block or Warn.",
        },
        generate_alert: ALERT_RECIPIENTS,
        priority: { type: "integer", description: "Rule priority (lower runs first)" },
      },
    },
  },
  {
    name: "create_copilot_dlp_policy",
    description:
      "Create a DLP policy scoped to Microsoft 365 Copilot & Copilot Chat — controls what Copilot may process or ground responses on. Add rules with create_copilot_dlp_rule. WRITE operation.",
    annotations: { title: "Create Copilot DLP policy", ...CREATE },
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
    annotations: { title: "Create Copilot DLP rule", ...CREATE },
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
      "List Sensitive Information Types (SITs) visible to the tenant: built-in Microsoft types and any custom types the org has created. Use this to find the exact SIT name needed by create_dlp_rule's sensitive_information_types parameter. Does not include trainable classifiers (a separate classification mechanism).",
    annotations: { title: "List sensitive information types", ...READ },
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

function closeObjectSchemas(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object" && schema.additionalProperties === undefined) {
    schema.additionalProperties = false;
  }
  for (const child of Object.values(schema.properties ?? {})) closeObjectSchemas(child);
  if (schema.items) closeObjectSchemas(schema.items);
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    for (const child of schema[keyword] ?? []) closeObjectSchemas(child);
  }
  if (schema.not) closeObjectSchemas(schema.not);
}

for (const tool of TOOLS) closeObjectSchemas(tool.inputSchema);

const toolsByName = new Map(TOOLS.map((tool) => [tool.name, tool]));
const LIST_TOOL_NAMES = [
  "list_sensitivity_labels",
  "list_label_policies",
  "list_dlp_policies",
  "list_dlp_rules",
  "list_sensitive_information_types",
];
const PAGINATED_TOOL_NAMES = [...LIST_TOOL_NAMES, "get_dlp_rule"];
const LIST_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "count", "total_count", "has_more", "next_cursor"],
  properties: {
    items: { type: "array", items: { type: "object", additionalProperties: true } },
    count: { type: "integer", minimum: 0 },
    total_count: { type: "integer", minimum: 0 },
    has_more: { type: "boolean" },
    next_cursor: { type: ["string", "null"] },
  },
};
for (const name of PAGINATED_TOOL_NAMES) {
  const tool = toolsByName.get(name);
  tool.inputSchema.properties.limit = { type: "integer", minimum: 1, maximum: 100, default: 25 };
  tool.inputSchema.properties.cursor = {
    type: "string",
    minLength: 1,
    maxLength: 2048,
    description: "Opaque cursor returned by the previous call with the same filters.",
  };
  tool.outputSchema = LIST_OUTPUT_SCHEMA;
}
toolsByName.get("get_dlp_rule").inputSchema.oneOf = [
  { required: ["identity"], not: { required: ["policy"] } },
  { required: ["policy"], not: { required: ["identity"] } },
];
toolsByName.get("create_copilot_dlp_rule").inputSchema.oneOf = [
  { required: ["sensitive_information_types"], not: { required: ["sensitivity_labels"] } },
  { required: ["sensitivity_labels"], not: { required: ["sensitive_information_types"] } },
];
toolsByName.get("list_sensitive_information_types").inputSchema.properties.scope.default = "all";


export { TOOLS };
