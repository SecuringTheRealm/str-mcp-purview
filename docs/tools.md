# Tools, prompts and resources

## How the tools work

All tools return compact, token-efficient output. List tools return one line per result; detail tools return structured markdown. This is intentional — the server is designed to be lean so tool responses do not consume large portions of your context window.

### Data sources

There are two data sources in use and it is worth understanding the difference:

**Microsoft Graph (beta)** — queried by `get_label_policy_settings`. It makes a targeted request to `/beta/security/informationProtection/labelPolicySettings`, authenticated with a token from `@azure/identity`.

**Security & Compliance PowerShell** — queried by sensitivity-label, label-policy, and all `*_dlp_*` configuration tools. The server keeps one long-lived `pwsh` process, runs `Connect-IPPSSession` once, and streams the relevant cmdlets into that session. It is authoritative for label reads and writes, avoiding Graph replication lag and preserving SCC names, GUIDs, and display names together.

## Tools

### Tool exposure modes

Set `PURVIEW_TOOL_MODE` to choose the MCP surface. All modes use the same capability handlers, authentication and argument validation.

| Mode | Visible tools (unrestricted) | Intended use |
| --- | ---: | --- |
| `full` (default) | 37 | Existing deployments, diagnostics and detailed schemas |
| `compact` | 8 | **Recommended** for new agent configurations |
| `dispatcher` | 3 | Minimal surface for a growing capability catalogue |

The default remains **full** so existing clients retain their operation names. The catalogue includes ten service-side auto-label capabilities and `get_auth_status` for local configuration diagnostics. To migrate, set `PURVIEW_TOOL_MODE=compact`, restart the server and refresh the client's tool discovery. No authentication or startup-command changes are needed. The detailed tools documented below become internal operation IDs in compact/dispatcher mode, not individually advertised tools.

Compact exposes `purview_search`, `purview_describe_capability`, `purview_labels`, `purview_manage_labels`, `purview_dlp`, `purview_manage_dlp`, `purview_classification` and `purview_auth`. Read and write operations are separate so hosts can apply meaningful approval policies. Each domain tool accepts an `operation` enum and an `arguments` object. Dispatcher exposes `purview_search_capabilities`, `purview_describe_capability` and `purview_execute_capability`. Its executor is conservatively annotated as potentially destructive; annotations are hints, not authorization.

Generic stdio configuration (merge your existing authentication environment):

```json
{
  "mcpServers": {
    "purview": {
      "command": "node",
      "args": ["/absolute/path/to/str-mcp-purview/index.js"],
      "env": {
        "PURVIEW_TOOL_MODE": "compact",
        "PURVIEW_TOOL_LIMIT": "8"
      }
    }
  }
}
```

For dispatcher mode, change only the mode value to `dispatcher`. The same environment settings apply to containers and the Functions host; `functions/local.settings.json.example` opts new deployments into compact mode. `PURVIEW_TOOL_LIMIT` caps search candidates; it does not limit the number of registered tools. Both variables are listed under [Environment variables](#environment-variables).

Example compact workflow:

```json
{"name":"purview_search","arguments":{"query":"Find DLP policies that apply to SharePoint","domain":"dlp","action":"read","limit":1}}
```

Search returns lightweight ranked IDs, descriptions, scores, risk and an `invocation` mapping, with **no schemas by default**. It searches available **operations**, not tenant objects. Describe only the selected operation:

```json
{"name":"purview_describe_capability","arguments":{"capability_id":"list_dlp_policies"}}
```

Describe returns the exact `input_schema`, optional output schema, constraints, illustrative arguments, authorization requirements and invocation mapping. It does not execute the operation or guarantee backend access. Then query tenant data:

```json
{"name":"purview_dlp","arguments":{"operation":"list_dlp_policies","arguments":{"workload":"SharePoint","limit":25}}}
```

In dispatcher mode the equivalent call is `purview_execute_capability` with `capability_id: "list_dlp_policies"` and the same nested arguments. Subsequent pages use the returned `next_cursor` as `cursor`, keeping other filters unchanged. Deletes require user confirmation through form elicitation; `confirm: true` is accepted for compatibility but cannot bypass that interaction. `purview_auth` / `get_auth_status` only reports local configuration: it does not sign in, validate credentials or prove tenant access.

Migration from the earlier compact/dispatcher surface: refresh tool discovery and use describe before execution. Clients needing the previous eager-schema search can set `include_schemas: true`. A caller that already knows the schema can execute directly; search/describe are discovery aids, not security tokens. Full-mode tool names and argument/result contracts are unchanged.

### Compatibility corrections to DLP writes

- `generate_alert` now takes a non-empty recipient array, for example `["security@contoso.com", "SiteAdmin"]`. The former boolean shape was not the cmdlet's contract. Refresh client schemas; no recipients are silently inferred. This does not add incident-report functionality. [GenerateAlert](https://learn.microsoft.com/powershell/module/exchangepowershell/new-dlpcompliancerule#-generatealert).
- SIT confidence `Low`/`Medium`/`High` uses the documented grouped OR shape with minimum confidence 65/75/85 and maximum 100. Bare SIT strings remain supported. [Grouped syntax](https://learn.microsoft.com/powershell/module/exchangepowershell/new-dlpcompliancerule#examples), [confidence levels](https://learn.microsoft.com/purview/sit-sensitive-information-type-learn-about#more-on-confidence-levels).
- OneDrive exclusions map to `ExceptIfOneDriveSharedBy`, not the obsolete `OneDriveLocationException` family. Create accepts user UPNs or `All`, not site URLs. Set reads the policy first, merges user additions/removals and preserves unrelated scope entries. Inclusion and exclusion scopes cannot coexist. Ambiguous edits, legacy site-based policies, unresolved identities and removal of the last inclusion are rejected rather than silently changing coverage. Use `remove_locations.onedrive:["All"]` to disable the location explicitly. Read/modify/write is not transactional against changes made by other administrators; avoid concurrent edits. [OneDrive scope contract](https://learn.microsoft.com/powershell/module/exchangepowershell/set-dlpcompliancepolicy#-onedrivesharedby).
- SharePoint, Teams and Endpoint exclusions require an effective `All` location scope. Sender/recipient (`from`, `sent_to`) exceptions read the parent policy and require Exchange-only scope before mutation. Content-property exceptions require `Property:value1,value2` syntax. [Exception constraints](https://learn.microsoft.com/powershell/module/exchangepowershell/new-dlpcompliancerule#-exceptiffrom).

### Environment variables

Read once from the server's process environment, on stdio and HTTP alike. Auth variables are in [auth.md](auth.md#auth-environment-variables); HTTP host variables are in [hosting.md](hosting.md#http-host-environment-variables).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PURVIEW_TOOL_MODE` | `full` | `full`, `compact` or `dispatcher`. Any other value is an error. |
| `PURVIEW_TOOL_LIMIT` | `8` | Search candidates returned by `purview_search` / `purview_search_capabilities`; integer 1-20. |
| `PURVIEW_READ_ONLY` | `false` | `true` denies every write capability. |
| `PURVIEW_ALLOW_DESTRUCTIVE` | `true` | `false` denies capabilities marked destructive (deletes and `set_*` updates). |
| `PURVIEW_ALLOWED_CAPABILITIES` | unset (all allowed) | Comma-separated canonical IDs. Set but empty denies all. |
| `PURVIEW_ALLOWED_DOMAINS` | unset (all allowed) | Comma-separated `labels`, `dlp`, `classification`, `auth`. Set but empty denies all. |
| `PURVIEW_PERMISSIONS` | unset (not checked) | Trusted permission labels matched against capability metadata. |
| `PURVIEW_SCOPES` | unset (not checked) | Trusted Microsoft scope names matched against declared alternatives. |
| `PURVIEW_FEATURES` | unset (none enabled) | Enabled feature flags for feature-gated capabilities. |
| `PURVIEW_MAX_QUEUED_COMMANDS` | `3` | PowerShell commands that may wait behind the running one; more are refused at once (nothing sent, safe to retry). |

`PURVIEW_READ_ONLY` and `PURVIEW_ALLOW_DESTRUCTIVE` accept `true`/`false` (also `1`/`0`, `yes`/`no`, case-insensitive); any other value stops the server at startup.

### Capability policies and retrieval

Retrieval runs entirely in-process: permission/domain/action/risk filtering, then deterministic BM25 with ID/alias, domain and verb boosts. There is no routing LLM, vector database, network search or new dependency. The client model chooses among the candidates and supplies arguments; the server resolves the exact ID and validates the original schema before calling Graph or PowerShell. Unknown fields, denied operations and mismatched compact domains are rejected.

Server-side restrictions are set through the environment variables [listed above](#environment-variables).

These restrictions apply to discovery, retrieval and execution; resources cannot bypass them. Unset permission/scope lists defer to backend authorization. Currently Graph policy settings declare delegated/application scope alternatives; PowerShell operations still rely on Microsoft's tenant RBAC, not an inferred role list. Configuration values do **not** grant Microsoft permissions, and the HTTP host does not automatically turn caller claims into capability scopes. A trusted embedding host can pass `capabilityPolicy` to `createServer`; it is intersected with server restrictions, never widened by tool arguments. Permission-sensitive discovery is privately cached with zero TTL.

Catalogue resources return only the first 25 items with pagination information. Existing list capabilities remain bounded (default 25, maximum 100); backend calls may still fetch a full collection before local filtering/pagination. This reduces model context, not necessarily backend retrieval cost.

An embedding host may also provide `authorizeCapability({capability, arguments})` to `createServer`. This trusted hook runs after schema validation and before the handler on **every execution**, including resource reads. It must return exactly `true`; false, missing results and exceptions deny the call. It can inspect resource identities/arguments (for example, forbid production-policy changes); it cannot widen capability permissions. Argument copies prevent hook mutations from changing the eventual operation. No new policy engine is required. This is an extension point, not a tenant policy admin interface or automatic mapping of HTTP identity claims.

Tool errors retain `isError` and readable text, and now include `structuredContent.error` with `code`, `message`, and `retryable:false`. Codes distinguish `VALIDATION_ERROR`, `CAPABILITY_UNAVAILABLE` (unknown and unauthorized IDs deliberately share a response), `POLICY_DENIED`, `BACKEND_ERROR`, and unexpected `INTERNAL_ERROR`. Backend failures are conservatively non-retryable at this boundary: a failed write may already have taken effect. Existing integration-specific retry behaviour is unchanged; agents must not blindly retry mutations.

Every tool below is documented two ways: **Business** — why an admin would reach
for it and what they get back — and **Technical** — the exact Graph endpoint or
PowerShell cmdlet it runs and how. Tools are grouped by data plane; writes are
flagged and only exist on the PowerShell plane.

### Sensitivity labels — Security & Compliance PowerShell

#### `list_sensitivity_labels`

- **Business:** See every sensitivity label the signed-in admin can view — the *Public / Internal / Confidential*-style classifications your org uses to tag data. This is the starting point: it hands you the label ID you need to inspect any single label in detail.
- **Technical:** `Get-Label` via Security & Compliance PowerShell. Returns the full GUID, immutable SCC name, display name, priority, state, and parent identity without truncating addressable fields. Optional filters are applied client-side.

| Parameter | Type | Description |
|-----------|------|-------------|
| `active` | boolean | Optional — only active (`true`) or inactive (`false`) labels |
| `parent` | string | Optional — only sub-labels of this parent (name or GUID) |

---

#### `get_sensitivity_label`

- **Business:** Drill into one label to see its SCC identity, display metadata, hierarchy, state, and the **protection** it applies (encryption, markings, container/Teams settings).
- **Technical:** `Get-Label -Identity <name|GUID>`. Because reads and writes use the same plane, a successful `New-Label` or `Set-Label` is immediately readable without waiting for Graph replication.

| Parameter | Type | Description |
|-----------|------|-------------|
| `label_id` | string | Sensitivity label SCC name or GUID, from `list_sensitivity_labels` |
| `include_protection_settings` | boolean | Deprecated compatibility flag; protection settings are always returned |

---

#### `get_label_policy_settings`

- **Business:** Understand the *rules of engagement* for labelling in the tenant — is applying a label mandatory, must users justify downgrading a label, and what label applies by default? These settings govern day-to-day user behaviour, not the labels themselves.
- **Technical:** `GET /beta/security/informationProtection/labelPolicySettings` via Microsoft Graph, scoped to the signed-in admin. Returns markdown covering mandatory labelling, downgrade-justification requirement, and the default label ID.

*No parameters.*

---

#### `list_label_policies`

- **Business:** See every label **publishing policy** — which labels are actually published to which users, and whether each policy is live. This is the read that makes the label-policy write tools verifiable.
- **Technical:** `Get-LabelPolicy` on the PowerShell plane. One line per policy: name, state, published-label count, creation date.

*No parameters.*

#### `get_label_policy`

- **Business:** Inspect one publishing policy in full — the labels it publishes, the mailboxes/groups it targets, and its behaviour settings (mandatory labelling, default label).
- **Technical:** `Get-LabelPolicy -Identity <name|GUID>` with an enriched property set (labels, locations, settings), summarised as markdown.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | Label policy name or GUID |

---

### Sensitivity labels — write & publish (Security & Compliance PowerShell)

Label configuration is read and written through PowerShell, while the separate `get_label_policy_settings` tool remains Graph-backed. These tools cover the full label lifecycle without cross-plane replication gaps.

> **Prerequisite:** label reads and writes require PowerShell 7+ and an IPPSSession sign-in (the same bridge as the DLP tools).

The two label tools share a category-grouped settings surface — `encryption`, `content_marking` (header/footer/watermark), `site_and_group_protection` (Groups/Teams/SharePoint containers), and `teams_protection` (meetings) — passed as nested objects and flattened to the underlying `New-/Set-Label` parameters.

#### `create_sensitivity_label`

- **Business:** Define a new classification — its name, tooltip, and optionally the protection it applies (encryption, visual markings, container/Teams controls). A created label is invisible to users until published (see `create_label_policy`).
- **Technical:** **Write.** `New-Label`. Required: `name`, `display_name`, and `tooltip` for ordinary labels. Set `is_label_group:true` to create an organisational parent for modern-scheme sub-labels; a group's tooltip is optional. Groups accept display name, descriptions and colour, and reject parent/protection settings. Reads expose group status. Classic tenants can still use an ordinary parent label.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique internal label name |
| `display_name` | string | Name shown to users |
| `tooltip` | string | Guidance shown at classification time |
| `is_label_group` | boolean | Create an organisational group with `New-Label -IsLabelGroup`; default is an ordinary label |
| `parent_id` | string | Optional — parent name/GUID; modern-scheme tenants require an existing label group |
| `color` | string | Six-digit RGB hex code, e.g. `#123ABC`; mapped to `AdvancedSettings.color` |
| `encryption` | object | `enabled`, `protection_type`, `do_not_forward`, `encrypt_only`, `offline_access_days`, `rights_definitions[]` |
| `content_marking` | object | `header` / `footer` / `watermark`, each with `enabled`, `text`, `font_color`, `font_size`, `alignment`/`layout` |
| `site_and_group_protection` | object | `enabled`, `privacy`, `allow_guest_access`, `external_sharing_control`, `access_level` |
| `teams_protection` | object | `enabled`, `allow_meeting_chat`, `allowed_presenters`, `end_to_end_encryption`, `prevent_copy` |
| `comment` | string | Admin comment |

#### `set_sensitivity_label`

- **Business:** Change an existing label — rename, retint the tooltip, or adjust any of its protection settings — without recreating it.
- **Technical:** **Write.** `Set-Label -Identity <name|GUID>`. Takes `identity` plus any of the same settings groups above; only supplied fields change.

#### `create_label_policy`

- **Business:** **Publish** labels so users can actually apply them, and set behaviour like mandatory labelling or a default label. Creation *is* publishing — there's no separate step; changes replicate to clients automatically (can take up to ~24h).
- **Technical:** **Write.** `New-LabelPolicy`. Targets Exchange mailboxes and/or Microsoft 365 Groups; behaviour goes in `advanced_settings`.

At least one nonempty `exchange_location` or `modern_group_location` target is required. Missing targets fail validation before PowerShell; the server never defaults publishing to everyone. For example: `{"name":"Finance publishing","labels":["Finance"],"exchange_location":["finance.admin@contoso.com"]}`. Policy details render object locations as readable names and identities.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique policy name |
| `labels` | string[] | Labels to publish (names or GUIDs) |
| `exchange_location` | string[] | Mailboxes to publish to, or `["All"]` |
| `modern_group_location` | string[] | Microsoft 365 Groups (SMTP addresses) |
| `advanced_settings` | object | Key→value behaviour, e.g. `{"OutlookDefaultLabel":"General","TeamworkMandatory":"True"}` |
| `comment` | string | Optional description/comment |

#### `set_label_policy`

- **Business:** Adjust a live publish policy — add or remove which labels it publishes, or change behaviour settings.
- **Technical:** **Write.** `Set-LabelPolicy -Identity <name|GUID>` with `add_labels[]` / `remove_labels[]` / `advanced_settings` / `comment`.

#### `remove_sensitivity_label`

- **Business:** Permanently delete a sensitivity label. Review dependent policies first — deleting a published label affects users.
- **Technical:** **Destructive write.** `Remove-Label -Identity <name|GUID> -Confirm:$false`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | Sensitivity label name or GUID to delete |

#### `remove_label_policy`

- **Business:** Permanently delete a publish policy, unpublishing its labels from users.
- **Technical:** **Destructive write.** `Remove-LabelPolicy -Identity <name|GUID> -Confirm:$false`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | Label policy name or GUID to delete |

> **Write operations change tenant configuration.** Test against a non-production tenant first.

---

### DLP policies & rules — Security & Compliance PowerShell

#### `list_dlp_policies`

- **Business:** Get an at-a-glance inventory of the tenant's Data Loss Prevention policies — the containers that decide *where* protection applies (Exchange, SharePoint, etc.) and whether each is live-enforcing, in test, or off.
- **Technical:** `Get-DlpCompliancePolicy` in the persistent `Connect-IPPSSession` bridge. Output is trimmed to key properties (name, mode/state, workload, creation date) — one line per policy — to stay token-lean. Optional filters are applied client-side.

| Parameter | Type | Description |
|-----------|------|-------------|
| `mode` | string | Optional — only policies in this exact mode (`Enable`, `TestWithNotifications`, `TestWithoutNotifications`, `Disable`) |
| `workload` | string | Optional — only policies whose workload contains this text (e.g. `Endpoint`, `Exchange`) |

---

#### `get_dlp_policy`

- **Business:** Inspect one DLP policy in full — its enforcement mode, exactly which locations/workloads it targets (and exclusions), who created it and when — before deciding whether to change or enforce it.
- **Technical:** `Get-DlpCompliancePolicy -Identity <name|GUID>`. Detail reads select a **richer property set** than the list tools, so output stays lean in bulk but deep on demand. Report covers GUID, mode, enabled state, workload, type, comment, creation metadata, and a summarised **Locations** line (per-workload scope + exclusions).

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | DLP policy name or GUID |

---

#### `list_dlp_rules`

- **Business:** See the *actual protection logic* — the rules inside your policies that define what sensitive content is detected and what happens on a match (block, alert, notify). This is where you spot rules that detect data but take no action, or rules left disabled.
- **Technical:** `Get-DlpComplianceRule`, optionally filtered by policy. One line per rule: name, enabled/disabled state, priority, parent policy, block-access flag, and detected sensitive information types.

| Parameter | Type | Description |
|-----------|------|-------------|
| `policy` | string | Optional — restrict to rules in this DLP policy (name or GUID) |
| `disabled_only` | boolean | Optional — only disabled rules |
| `blocking_only` | boolean | Optional — only rules that block access |

---

#### `get_dlp_rule`

- **Business:** Get the *full* detail behind a rule — conditions, block scope, notified users, alert severity, **exceptions**, restrict-access actions, stop-processing, policy-tip — either for one rule you've identified, or for every rule in a policy when reviewing that policy in depth. (`list_dlp_rules` gives the one-line overview; this gives the deep dive.)
- **Technical:** `Get-DlpComplianceRule`. Provide **exactly one** of `identity` (one rule) or `policy` (all rules in it). Supplying neither is a scoped error. The single-rule path selects a **richer property set** (exceptions, `RestrictAccess`, `StopPolicyProcessing`, incident report, policy tip), summarised compactly; the bulk path stays lean and is bounded to one policy. *(Exact `ExceptIf*`/location property names should be confirmed against a live tenant.)*

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | A single DLP rule name or GUID — returns that one rule |
| `policy` | string | A DLP policy name or GUID — returns full detail for every rule in it |

---

#### `create_dlp_policy`

- **Business:** Stand up a new DLP control — the empty container that says *which locations* to protect. Best practice is to create it in a **Test mode** first so you can see what it would catch before it blocks anything; add the detection rules afterwards with `create_dlp_rule`.
- **Technical:** **Write.** `New-DlpCompliancePolicy` with the supplied name, mode, comment, and location parameters. Returns the created policy's key fields.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique policy name |
| `mode` | string | Policy mode: `Enable`, `TestWithNotifications`, `TestWithoutNotifications`, `Disable` (default `TestWithNotifications`) |
| `comment` | string | Optional description/comment |
| `exchange_location` | string[] | Exchange locations, e.g. `["All"]` |
| `sharepoint_location` | string[] | SharePoint locations, e.g. `["All"]` |
| `onedrive_location` | string[] | `["All"]` or user UPNs, never site URLs; UPNs map to `OneDriveSharedBy` |
| `teams_location` | string[] | Teams chat/channel locations, e.g. `["All"]` |
| `location_exceptions` | object | Exclusions for `sharepoint`, `onedrive`, or `teams` (each a string array) |

---

#### `set_dlp_policy`

- **Business:** Change an existing policy's enforcement level — most importantly, **promote a policy from Test to enforcement** once you're confident it behaves correctly (or pull it back to test / turn it off) — and **grow or shrink where it applies** by adding/removing locations per workload. This closes the test → enforce lifecycle that `create_dlp_policy` begins.
- **Technical:** **Write.** `Set-DlpCompliancePolicy -Identity <name|GUID>` with `-Mode`, `-Comment`, and/or the `-Add*/-Remove*Location` parameters. Only supplied fields change. *(Note: this is the modern unified-DLP cmdlet, not the retired Exchange-only `Set-DlpPolicy`.)*

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | DLP policy name or GUID to modify |
| `mode` | string | New mode: `Enable` (enforce), `TestWithNotifications`, `TestWithoutNotifications`, `Disable` |
| `comment` | string | Optional — replace the policy's description/comment |
| `add_locations` | object | Locations to add, per workload: `exchange`, `sharepoint`, `onedrive`, `teams`, `endpoint` (each a string array, or `["All"]`) |
| `remove_locations` | object | Locations to remove, same shape as `add_locations` |
| `add_location_exceptions` | object | Add exclusions for `sharepoint`, `onedrive`, `teams`, or `endpoint` |
| `remove_location_exceptions` | object | Remove exclusions, using the same shape |

---

#### `create_dlp_rule`

- **Business:** Add the actual detection logic to a policy — "if content contains *these* sensitive information types, then block / alert / notify." A policy does nothing until it has at least one rule.
- **Technical:** **Write.** `New-DlpComplianceRule` inside the named policy. Supports tuned SIT conditions, access scope, severity, customised notifications, common exceptions, and the existing block/notify/alert actions.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique rule name |
| `policy` | string | Parent DLP policy name or GUID |
| `sensitive_information_types` | (string\|object)[] | SIT name strings, or `{name, min_count?, max_count?, confidence_level?}`; existing strings remain valid |
| `block_access` | boolean | Action — block access to matching content |
| `notify_user` | string[] | Action — notify these users (emails, or `["Owner","LastModifier"]`) |
| `generate_alert` | string[] | Alert-recipient email addresses or `SiteAdmin`; booleans are rejected |
| `access_scope` | string | `InOrganization`, `NotInOrganization`, or `None` |
| `report_severity_level` | string | `None`, `Low`, `Medium`, or `High`; reporting metadata, not enforcement |
| `notification_email_subject` | string | Custom subject for user notification emails |
| `notification_email_body` | string | Custom email body (max 5,000 characters; supports Purview tokens/limited HTML) |
| `policy_tip_text` | string | Plain-text policy tip shown to users (max 256 characters) |
| `exceptions` | object | Common `ExceptIf*` conditions: SITs, document/property words or patterns, extensions, senders, recipients, groups, and domains |
| `priority` | integer | Rule priority (lower runs first) |

---

#### `set_dlp_rule`

- **Business:** Tune an existing rule without recreating it — flip on blocking, change who gets notified, adjust priority, change the detected sensitive info types, retune an endpoint rule's device restrictions (e.g. audit → block), or disable the rule entirely while you investigate. Covers traditional, endpoint, and Copilot rules.
- **Technical:** **Write.** `Set-DlpComplianceRule -Identity <name|GUID>`. Only the fields you supply change.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | Rule name or GUID to modify |
| `sensitive_information_types` | (string\|object)[] | Replace SIT conditions; accepts the same tuned form as `create_dlp_rule` |
| `block_access` | boolean | Set the block-access action |
| `notify_user` | string[] | Replace the notify-user list |
| `generate_alert` | string[] | Set alert recipients (email addresses or `SiteAdmin`); omission leaves existing settings unchanged |
| `access_scope` | string | Set or clear the inside/outside-organisation condition |
| `report_severity_level` | string | Set detection/reporting severity |
| `notification_email_subject` | string | Set the custom notification subject |
| `notification_email_body` | string | Set the custom notification body |
| `policy_tip_text` | string | Set the custom policy-tip text |
| `exceptions` | object | Set common rule exceptions using the create shape |
| `priority` | integer | Set rule priority |
| `disabled` | boolean | Enable (`false`) or disable (`true`) the rule |
| `endpoint_restrictions` | object[] | Endpoint rules only — replace the activity restrictions (same shape as `create_endpoint_dlp_rule`; Block/Warn require `notify_user`) |

---

#### `remove_dlp_policy`

- **Business:** Permanently delete a DLP policy and every rule inside it.
- **Technical:** **Destructive write.** `Remove-DlpCompliancePolicy -Identity <name|GUID> -Confirm:$false`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | DLP policy name or GUID to delete |

#### `remove_dlp_rule`

- **Business:** Permanently delete a single DLP rule, leaving its parent policy intact.
- **Technical:** **Destructive write.** `Remove-DlpComplianceRule -Identity <name|GUID> -Confirm:$false`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | DLP rule name or GUID to delete |

---

### Endpoint DLP — Security & Compliance PowerShell

These two tools are kept **separate** from the traditional DLP tools above so the common (Exchange/SharePoint/OneDrive) workflow stays lean — the endpoint activity/action options only appear when you're actually doing endpoint work. Endpoint DLP governs sensitive-data activities on users' **onboarded devices**: printing, copy/paste to clipboard, screen capture, removable media (USB), and network shares — the activities [documented for `EndpointDlpRestrictions`](https://learn.microsoft.com/powershell/module/exchangepowershell/new-dlpcompliancerule).

> **Prerequisite:** devices must be [onboarded to Microsoft Purview](https://learn.microsoft.com/purview/device-onboarding-overview).
>
> **Browser & AI-site restrictions:** controlling paste/upload into browsers or specific AI/cloud domains ("Paste to supported browsers", sensitive service domains) is configured through **sensitive-service-domain groups in the Purview portal**, not through the rule-level `EndpointDlpRestrictions` surface these tools expose. See [restricting paste actions into browsers](https://learn.microsoft.com/purview/endpoint-dlp-create-policy-restrict-paste-in-browsers).

#### `create_endpoint_dlp_policy`

- **Business:** Stand up a device-scoped DLP control for a set of users — the container that brings their onboarded devices (and their Edge browsing) into scope. Add the actual on-device restrictions with `create_endpoint_dlp_rule`. Prefer a Test mode first.
- **Technical:** **Write.** `New-DlpCompliancePolicy` with `-EndpointDlpLocation`. Endpoint DLP is scoped by **user**, not mailbox or site; defaults to `["All"]` if no users are given.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique policy name |
| `endpoint_location` | string[] | Users whose onboarded devices are in scope — email/name/GUID, or `["All"]` (default) |
| `endpoint_location_exception` | string[] | Users whose onboarded devices are excluded from the policy |
| `mode` | string | `Enable`, `TestWithNotifications`, `TestWithoutNotifications`, `Disable` (default `TestWithNotifications`) |
| `comment` | string | Optional description/comment |

---

#### `create_endpoint_dlp_rule`

- **Business:** Define what happens on the device — for each activity (print, copy/paste, screen capture, USB, network share) choose whether to audit, warn, block, or ignore when content matches.
- **Technical:** **Write.** `New-DlpComplianceRule` with `-EndpointDlpRestrictions`. Each `{activity, action}` pair maps to a `@{Setting=<activity>; Value=<action>}` hashtable entry. Per the cmdlet docs, `Block`/`Warn` actions require `notify_user` — the tool enforces this before calling the tenant.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique rule name |
| `policy` | string | Parent endpoint DLP policy name or GUID |
| `sensitive_information_types` | string[] | Condition — sensitive information types to detect |
| `endpoint_restrictions` | object[] | **Required.** Each entry: `{ "activity": <activity>, "action": <action> }` |
| `notify_user` | string[] | Notify these users — **required when any action is `Block` or `Warn`** |
| `generate_alert` | string[] | Alert-recipient email addresses or `SiteAdmin`; booleans are rejected |
| `priority` | integer | Rule priority (lower runs first) |

**`activity` values** (the [documented](https://learn.microsoft.com/powershell/module/exchangepowershell/new-dlpcompliancerule) `EndpointDlpRestrictions` settings): `Print`, `CopyPaste`, `ScreenCapture`, `RemovableMedia`, `NetworkShare`.
**`action` values:** `Audit`, `Block`, `Warn`, `Ignore`.

---

### Microsoft 365 Copilot DLP — Security & Compliance PowerShell

Kept **separate** from traditional DLP so the Copilot-specific conditions/actions don't bloat the common workflow. These govern what **Microsoft 365 Copilot and Copilot Chat** may process or ground responses on — protecting against sensitive prompts and sensitive/labeled content being used by Copilot. Same `*-DlpCompliancePolicy`/`*-DlpComplianceRule` cmdlets; the policy is scoped to Copilot via a `Locations` template + `EnforcementPlanes=("CopilotExperiences")`, and label conditions stay in hashtable form (no raw JSON).

> Covers 3 of the 4 documented Copilot protections. **Not yet covered:** blocking external-email grounding (preview) — pending condition-parameter discovery. The Copilot location GUID and the `RestrictAccess` setting (`ExcludeContentProcessing`/`Block`) match [Microsoft's `New-DlpCompliancePolicy` reference, Example 4](https://learn.microsoft.com/powershell/module/exchangepowershell/new-dlpcompliancepolicy).

#### `create_copilot_dlp_policy`

- **Business:** Bring Microsoft 365 Copilot into DLP scope for a set of users — the container for rules that decide what Copilot can process or ground on. Prefer a Test mode first.
- **Technical:** **Write.** `New-DlpCompliancePolicy` with a `Locations` JSON scoping to the Copilot location + `EnforcementPlanes=("CopilotExperiences")`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique policy name |
| `user_scope` | string[] | Users the policy applies to — email/GUID, or `["All"]` (default) |
| `mode` | string | `Enable`, `TestWithNotifications`, `TestWithoutNotifications`, `Disable` (default `TestWithNotifications`) |
| `comment` | string | Optional description/comment |

---

#### `create_copilot_dlp_rule`

- **Business:** Define the Copilot protection — either "if a prompt contains these sensitive info types, don't process it (or don't use web search)" or "if content has these sensitivity labels, exclude it from Copilot grounding." One condition type per rule.
- **Technical:** **Write.** `New-DlpComplianceRule`. SITs → `ContentContainsSensitiveInformation @{Name}`; labels → the same param with a `groups`/`labels` hashtable. Action maps to `RestrictAccess` (ExcludeContentProcessing) or `RestrictWebGrounding $true`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique rule name |
| `policy` | string | Parent Copilot DLP policy name or GUID |
| `sensitive_information_types` | string[] | Condition — SITs to detect. **Mutually exclusive** with `sensitivity_labels` |
| `sensitivity_labels` | string[] | Condition — sensitivity-label GUIDs to exclude from Copilot. **Mutually exclusive** with `sensitive_information_types` |
| `action` | string | `block_processing` (default) or `block_web_search` (SIT condition only) |
| `notify_user` | string[] | Action — notify these users |
| `priority` | integer | Rule priority (lower runs first) |

Maps to the 4 Copilot protections: block sensitive prompts *(SITs + `block_processing`)*, block sensitive web grounding *(SITs + `block_web_search`)*, exclude labeled content *(labels + `block_processing`)*. External-email grounding is not yet exposed.

---

> **Write operations change tenant configuration.** Run them against a test tenant first, and prefer creating policies in a Test mode before enabling enforcement.

---

### Sensitive information types — Security & Compliance PowerShell (read-only)

#### `list_sensitive_information_types`

- **Business:** Look up the exact catalogue of detectable data types — built-in Microsoft ones (credit card numbers, SSNs, passport numbers…) plus any custom types your org has defined. You need the precise name from here to reference a type when building a DLP rule.
- **Technical:** `Get-DlpSensitiveInformationType`. One line per SIT: name, built-in/custom, and a short description. Custom SITs are identified by `Publisher` being something other than `Microsoft Corporation` (per Microsoft's documented convention). Does **not** include trainable classifiers — see [ROADMAP.md](../ROADMAP.md).

| Parameter | Type | Description |
|-----------|------|--------------|
| `scope` | string | `all` (default) or `custom` — restrict to the org's own SITs |
| `name_contains` | string | Optional — only SITs whose name contains this text (case-insensitive) |

## Prompts

Prompts are pre-defined workflows that chain multiple tool calls and instruct the model to produce a structured report. In VS Code they are available via the Copilot Chat prompt picker. All are read-only analyses — they make no changes.

The analysis layer applies **data-security judgment**, not just reads: it traces whether classifications (SITs, labels) translate into *enforced* controls, classifies gaps as **Effectiveness** (data not protected) or **Hygiene** (quality) rather than imposing a severity score, and ends every recommendation in a concrete next action. `data-security-posture` is the front door; `dlp-control-review` is a focused DLP drill-down. Findings are also tagged **[config]** (a fact from settings) or **[assessment]** (the model's judgement).

### `data-security-posture`

The flagship assessment. Traces the **protection chain** — *define → reference → enforce → cover* — across the tenant's classification primitives, and reports where it breaks (e.g. a control referencing sensitive data but stuck in Test mode = "false security"). Key design choices:

- **Opt-in direction:** custom SITs and labels are walked catalog-out (an unused one the org *built* is a real gap); built-in SITs are considered only where policies already reference them — it deliberately does **not** enumerate the 280+ built-ins.
- **Business context with provenance:** the "should you be protecting X?" judgment needs context the tool doesn't own, so the prompt first uses any provided context, else asks, else infers a profile from deployment signals (label/SIT/policy names, workloads) — and tags every recommendation `[from stated context]` or `[inferred — confirm]`.

| Argument | Required | Description |
|----------|----------|-------------|
| `business_context` | no | The org's industry, jurisdictions, regulatory obligations, and sensitive data handled — used to judge which protections *should* exist. Omit and the prompt elicits or infers it. |

---

### `dlp-control-review`

Focused DLP drill-down — the depth counterpart to `data-security-posture`. Audits whether DLP controls are **well-built, non-conflicting, correctly scoped, alerted, and enforce-ready**, across enforcement readiness, rule correctness/conflicts (priority shadowing, monitor-only), scope & exceptions (using the enriched `get_dlp_policy`/`get_dlp_rule` detail), and alerting/hygiene. Findings are grouped **Effectiveness** then **Hygiene** (never ranked by severity) and tagged `[config]`/`[assessment]`; recommendations name the tool to use.

Handles the **stalled test-mode** question honestly: mode-change history isn't available, so it uses `WhenCreated`/`WhenChangedUTC` as a proxy, always shows the dates, and never flags a recently created policy.

| Argument | Required | Description |
|----------|----------|-------------|
| `policy` | no | Focus the review on a single DLP policy (name or GUID). Omit for tenant-wide. |

## Resources

Resources are user/host-attached context, distinct from tools: instead of the model calling them mid-reasoning, a user (or a host that supports it) attaches them directly to a conversation. All resources are live-queried on every read (no caching).

Resources here deliberately mirror **classification vocabulary** — the labels and sensitive information types you *reference* when reasoning about policy — not live posture (DLP policies/rules), which is better fetched on demand via the tools. Each resource is backed by the same data as its sibling `list_*` tool.

| URI | Description |
|-----|--------------|
| `purview://label-catalog` | All sensitivity labels visible to the tenant — the classification vocabulary. |
| `purview://sit-catalog` | All sensitive information types visible to the tenant — built-in and custom. |
| `purview://sit-catalog/custom` | Only the org's custom sensitive information types. |

## Typical workflows

**Inspect a sensitivity label you have heard about:**
> Call `list_sensitivity_labels`, then `get_sensitivity_label` with the ID returned.

**Assess your whole data-security posture:**
> Use the `data-security-posture` prompt (optionally pass `business_context`).

**Deep-dive on DLP control quality:**
> Use the `dlp-control-review` prompt (optionally scope to one `policy`).

**Stand up a new DLP control in test mode:**
> Call `create_dlp_policy` with `mode: "TestWithNotifications"`, then `create_dlp_rule` with the sensitive information types to detect and `block_access: true`.
