# str-mcp-purview

> A local MCP server that lets AI agents read and write Microsoft Purview **data security** configuration — sensitivity labels and DLP policies — as the signed-in admin.

![GitHub issues](https://img.shields.io/github/issues/SecuringTheRealm/str-mcp-purview)
![GitHub](https://img.shields.io/github/license/SecuringTheRealm/str-mcp-purview)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3178C6?logo=node.js&logoColor=ffffff)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-3178C6)](https://modelcontextprotocol.io/)

This server targets the **Microsoft 365 / Microsoft Purview compliance** surface with real API calls, designed for coding agents (Claude Code, VS Code / GitHub Copilot) running locally.

## Why a hybrid design

The modern Purview developer surface is split across planes, and no single one covers read *and* write for data-security config:

| Plane | Used for | R/W here |
| --- | --- | --- |
| **Microsoft Graph** (`/beta/security/informationProtection`) | Sensitivity label discovery & policy settings | Read |
| **Security & Compliance PowerShell** (`Connect-IPPSSession`) | DLP policy & rule CRUD — *not exposed through Graph* | Read + Write |

So this server is a **hybrid**: raw Microsoft Graph calls for labels, and a persistent PowerShell bridge (`ExchangeOnlineManagement` → `Get/New/Set-DlpCompliance*`) for DLP. Both act as the **delegated signed-in admin**, so every action honours that admin's Purview RBAC.

> Current scope: **sensitivity labels (read)** and **DLP policies (read/write)**. Insider Risk Management, Communications Compliance, and DSPM are planned follow-ups.

## Prerequisites

- **Node.js 20+**
- **PowerShell 7+** (`pwsh`) with the Exchange Online module — needed only for the DLP tools:
  ```powershell
  Install-Module ExchangeOnlineManagement -Scope CurrentUser
  ```
- A **Microsoft Entra app registration** (public client / native) in your tenant with the **delegated** `InformationProtectionPolicy.Read` permission granted with admin consent, and redirect URI `http://localhost`. Needed only for the sensitivity-label tools.
- An account with the appropriate Microsoft Purview roles (e.g. *Compliance Administrator* / *Information Protection*).

## Install

```bash
git clone <this-repo>
cd str-mcp-purview
npm install
```

## Test

```bash
npm test
```

Runs the unit and integration test suite with Node's built-in test runner (`node:test`), covering the formatting helpers, sensitivity-label and DLP data-access/formatting logic, the PowerShell bridge protocol, and the MCP server's tool/prompt registration and dispatch (via a real stdio child-process round trip). No test framework dependency is required — Node 20+ ships `node:test` out of the box.

## Configure

Set two environment variables (see `.env.template` for the full list). On Windows, storing them as user environment variables keeps them out of any file:

```powershell
[System.Environment]::SetEnvironmentVariable("AZURE_TENANT_ID", "your-tenant-id", "User")
[System.Environment]::SetEnvironmentVariable("AZURE_CLIENT_ID", "your-app-id", "User")
```

### Claude Code

Add to your workspace `.mcp.json` (see `.mcp.json.example`):

```json
{
  "mcpServers": {
    "purview": { "type": "stdio", "command": "node", "args": ["index.js"] }
  }
}
```

### VS Code / GitHub Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "purview": { "type": "stdio", "command": "node", "args": ["${workspaceFolder}/index.js"] }
  }
}
```

## Authentication flow

- **Labels (Graph):** first label tool call triggers an interactive browser sign-in (or device code if `PURVIEW_AUTH_MODE=devicecode`). The token is cached in memory for the session.
- **DLP (PowerShell):** first DLP tool call starts a single background `pwsh` process and runs `Connect-IPPSSession`, which opens an interactive sign-in **once**. That session is reused for every later DLP command. Sign-in prompts and URLs are written to **stderr** so they never corrupt the MCP stdio channel.

## How the tools work

All tools return compact, token-efficient output. List tools return one line per result; detail tools return structured markdown. This is intentional — the server is designed to be lean so tool responses do not consume large portions of your context window.

### Data sources

There are two data sources in use and it is worth understanding the difference:

**Microsoft Graph (beta)** — queried by `list_sensitivity_labels`, `get_sensitivity_label`, and `get_label_policy_settings`. Each call is a targeted HTTPS request to `/beta/security/informationProtection`, authenticated as the signed-in admin with a token from `@azure/identity`. Read-only: the Graph label endpoints do not expose label creation or publishing.

**Security & Compliance PowerShell** — queried by all `*_dlp_*` tools. DLP policy and rule configuration is not available through Graph, so the server keeps one long-lived `pwsh` process, runs `Connect-IPPSSession` once, and streams the `Get/New/Set-DlpCompliance*` cmdlets into that session. This is the only plane that performs **writes**, and the only one that requires PowerShell 7+.

## Tools

Every tool below is documented two ways: **Business** — why an admin would reach
for it and what they get back — and **Technical** — the exact Graph endpoint or
PowerShell cmdlet it runs and how. Tools are grouped by data plane; writes are
flagged and only exist on the PowerShell plane.

### Sensitivity labels — Microsoft Graph (read-only)

#### `list_sensitivity_labels`

- **Business:** See every sensitivity label the signed-in admin can view — the *Public / Internal / Confidential*-style classifications your org uses to tag data. This is the starting point: it hands you the label ID you need to inspect any single label in detail.
- **Technical:** `GET /beta/security/informationProtection/sensitivityLabels` via Microsoft Graph, as the delegated admin. Returns one compact line per label: label ID, sensitivity order, active/inactive state, name (and parent, if a sub-label), and a truncated description. Optional filters are applied client-side.

| Parameter | Type | Description |
|-----------|------|-------------|
| `active` | boolean | Optional — only active (`true`) or inactive (`false`) labels |
| `parent` | string | Optional — only sub-labels of this parent (name or GUID) |

---

#### `get_sensitivity_label`

- **Business:** Drill into one label to understand exactly how it presents to users — its colour, the tooltip guidance shown at classification time, its position in the sensitivity hierarchy, and whether it's currently active.
- **Technical:** `GET /beta/security/informationProtection/sensitivityLabels/{id}` via Microsoft Graph. Returns a structured markdown report: sensitivity order, active state, colour, tooltip, description, and parent label.

| Parameter | Type | Description |
|-----------|------|-------------|
| `label_id` | string | Sensitivity label GUID, from `list_sensitivity_labels` |

---

#### `get_label_policy_settings`

- **Business:** Understand the *rules of engagement* for labelling in the tenant — is applying a label mandatory, must users justify downgrading a label, and what label applies by default? These settings govern day-to-day user behaviour, not the labels themselves.
- **Technical:** `GET /beta/security/informationProtection/labelPolicySettings` via Microsoft Graph, scoped to the signed-in admin. Returns markdown covering mandatory labelling, downgrade-justification requirement, and the default label ID.

*No parameters.*

---

### Sensitivity labels — write & publish (Security & Compliance PowerShell)

Labels are a **hybrid** domain: read through Graph (above), but **written** through PowerShell — Graph exposes no label create/publish surface. These four tools cover the full label lifecycle.

> **Prerequisite:** unlike the label *read* tools (Graph only), these **writes require PowerShell 7+ and an IPPSSession sign-in** (same bridge as the DLP tools). A Graph read may briefly lag a PowerShell write (replication).

The two label tools share a category-grouped settings surface — `encryption`, `content_marking` (header/footer/watermark), `site_and_group_protection` (Groups/Teams/SharePoint containers), and `teams_protection` (meetings) — passed as nested objects and flattened to the underlying `New-/Set-Label` parameters.

#### `create_sensitivity_label`

- **Business:** Define a new classification — its name, tooltip, and optionally the protection it applies (encryption, visual markings, container/Teams controls). A created label is invisible to users until published (see `create_label_policy`).
- **Technical:** **Write.** `New-Label`. Required: `name`, `display_name`, `tooltip`. Optional `parent_id` (sub-label) + the shared settings groups.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique internal label name |
| `display_name` | string | Name shown to users |
| `tooltip` | string | Guidance shown at classification time |
| `parent_id` | string | Optional — parent label to make this a sub-label |
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
| `mode` | string | Policy mode: `Enable`, `TestWithNotifications`, `TestWithoutNotifications`, `Disable` (default `Enable`) |
| `comment` | string | Optional description/comment |
| `exchange_location` | string[] | Exchange locations, e.g. `["All"]` |
| `sharepoint_location` | string[] | SharePoint locations, e.g. `["All"]` |
| `onedrive_location` | string[] | OneDrive locations, e.g. `["All"]` |

---

#### `set_dlp_policy`

- **Business:** Change an existing policy's enforcement level — most importantly, **promote a policy from Test to enforcement** once you're confident it behaves correctly (or pull it back to test / turn it off). This closes the test → enforce lifecycle that `create_dlp_policy` begins.
- **Technical:** **Write.** `Set-DlpCompliancePolicy -Identity <name|GUID>` with `-Mode` (and optionally `-Comment`). Only supplied fields change. *(Note: this is the modern unified-DLP cmdlet, not the retired Exchange-only `Set-DlpPolicy`.)*

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | DLP policy name or GUID to modify |
| `mode` | string | New mode: `Enable` (enforce), `TestWithNotifications`, `TestWithoutNotifications`, `Disable` |
| `comment` | string | Optional — replace the policy's description/comment |

---

#### `create_dlp_rule`

- **Business:** Add the actual detection logic to a policy — "if content contains *these* sensitive information types, then block / alert / notify." A policy does nothing until it has at least one rule.
- **Technical:** **Write.** `New-DlpComplianceRule` inside the named policy. Maps the supplied sensitive information types into the `ContentContainsSensitiveInformation` condition and the block/notify/alert/priority actions.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique rule name |
| `policy` | string | Parent DLP policy name or GUID |
| `sensitive_information_types` | string[] | Condition — sensitive information types to detect, e.g. `["Credit Card Number"]` |
| `block_access` | boolean | Action — block access to matching content |
| `notify_user` | string[] | Action — notify these users (emails, or `["Owner","LastModifier"]`) |
| `generate_alert` | boolean | Action — raise an alert on match |
| `priority` | integer | Rule priority (lower runs first) |

---

#### `set_dlp_rule`

- **Business:** Tune an existing rule without recreating it — flip on blocking, change who gets notified, adjust priority, or disable the rule entirely while you investigate.
- **Technical:** **Write.** `Set-DlpComplianceRule -Identity <name|GUID>`. Only the fields you supply change.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | Rule name or GUID to modify |
| `block_access` | boolean | Set the block-access action |
| `notify_user` | string[] | Replace the notify-user list |
| `generate_alert` | boolean | Set alert generation |
| `priority` | integer | Set rule priority |
| `disabled` | boolean | Enable (`false`) or disable (`true`) the rule |

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

### Endpoint & Microsoft Edge DLP — Security & Compliance PowerShell

These two tools are kept **separate** from the traditional DLP tools above so the common (Exchange/SharePoint/OneDrive) workflow stays lean — the endpoint activity/action options only appear when you're actually doing endpoint work. Endpoint DLP governs sensitive-data activities on users' **onboarded devices**, and this is also where **Microsoft Edge inline browser DLP** lives: the `PasteToBrowser` activity governs pasting sensitive text into Edge (e.g. prompts to AI apps like ChatGPT). Edge is natively supported; Chrome/Firefox require the Microsoft Purview browser extension.

> **Prerequisite:** devices must be [onboarded to Microsoft Purview](https://learn.microsoft.com/purview/device-onboarding-overview). Blocking prompts to *specific* AI/cloud domains additionally depends on the tenant's sensitive-service-domain settings, which are configured in the Purview portal (not exposed by these tools).

#### `create_endpoint_dlp_policy`

- **Business:** Stand up a device-scoped DLP control for a set of users — the container that brings their onboarded devices (and their Edge browsing) into scope. Add the actual on-device restrictions with `create_endpoint_dlp_rule`. Prefer a Test mode first.
- **Technical:** **Write.** `New-DlpCompliancePolicy` with `-EndpointDlpLocation`. Endpoint DLP is scoped by **user**, not mailbox or site; defaults to `["All"]` if no users are given.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique policy name |
| `endpoint_location` | string[] | Users whose onboarded devices are in scope — email/name/GUID, or `["All"]` (default) |
| `mode` | string | `Enable`, `TestWithNotifications`, `TestWithoutNotifications`, `Disable` (default `Enable`) |
| `comment` | string | Optional description/comment |

---

#### `create_endpoint_dlp_rule`

- **Business:** Define what happens on the device — for each activity (print, clipboard, USB, network share, **paste into the Edge browser**…) choose whether to audit, warn, block, or block-with-override when content matches. This is how you stop sensitive data being pasted into AI-app prompts in Edge.
- **Technical:** **Write.** `New-DlpComplianceRule` with `-EndpointDlpRestrictions`. Each `{activity, action}` pair maps to a `@{Setting=<activity>; Value=<action>}` hashtable entry. The persistent PowerShell bridge already marshals hashtable arrays, so no special handling is needed.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique rule name |
| `policy` | string | Parent endpoint DLP policy name or GUID |
| `sensitive_information_types` | string[] | Condition — sensitive information types to detect |
| `endpoint_restrictions` | object[] | **Required.** Each entry: `{ "activity": <activity>, "action": <action> }` |
| `notify_user` | string[] | Action — notify these users |
| `generate_alert` | boolean | Action — raise an alert on match |
| `priority` | integer | Rule priority (lower runs first) |

**`activity` values:** `Print`, `CopyToClipboard`, `RemovableMedia`, `NetworkShare`, `Bluetooth`, `RemoteDesktopServices`, `PasteToBrowser` *(Microsoft Edge)*, `ScreenCapture`.
**`action` values:** `Audit`, `Block`, `Warn`, `BlockWithOverride`, `Ignore` — not every action is valid for every activity; verify against a live tenant.

---

### Microsoft 365 Copilot DLP — Security & Compliance PowerShell

Kept **separate** from traditional DLP so the Copilot-specific conditions/actions don't bloat the common workflow. These govern what **Microsoft 365 Copilot and Copilot Chat** may process or ground responses on — protecting against sensitive prompts and sensitive/labeled content being used by Copilot. Same `*-DlpCompliancePolicy`/`*-DlpComplianceRule` cmdlets; the policy is scoped to Copilot via a `Locations` template + `EnforcementPlanes=("CopilotExperiences")`, and label conditions stay in hashtable form (no raw JSON).

> Covers 3 of the 4 documented Copilot protections. **Not yet covered:** blocking external-email grounding (preview) — pending condition-parameter discovery. The Copilot location GUID and `RestrictAccess` setting string are encoded from Microsoft's docs and should be verified against a live tenant.

#### `create_copilot_dlp_policy`

- **Business:** Bring Microsoft 365 Copilot into DLP scope for a set of users — the container for rules that decide what Copilot can process or ground on. Prefer a Test mode first.
- **Technical:** **Write.** `New-DlpCompliancePolicy` with a `Locations` JSON scoping to the Copilot location + `EnforcementPlanes=("CopilotExperiences")`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique policy name |
| `user_scope` | string[] | Users the policy applies to — email/GUID, or `["All"]` (default) |
| `mode` | string | `Enable`, `TestWithNotifications`, `TestWithoutNotifications`, `Disable` (default `Enable`) |
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
- **Technical:** `Get-DlpSensitiveInformationType`. One line per SIT: name, built-in/custom, and a short description. Custom SITs are identified by `Publisher` being something other than `Microsoft Corporation` (per Microsoft's documented convention). Does **not** include trainable classifiers — see [ROADMAP.md](ROADMAP.md).

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

## Architecture

```
index.js          MCP server: tool/prompt handlers, stdio transport
src/graph.js      Delegated Graph token (@azure/identity) + raw beta fetch
src/powershell.js Persistent pwsh IPPSSession bridge (sentinel-framed, base64 params)
src/labels.js     Sensitivity-label data access + formatters
src/dlp.js        DLP data access (read/write) + formatters
src/format.js     Shared token-efficient formatting helpers
```

The PowerShell bridge passes model-supplied parameters as a base64-encoded JSON blob rebuilt with `ConvertFrom-Json -AsHashtable`, keeping arguments out of the executable script text (no command injection), and serialises requests so framed output blocks never interleave.

## Roadmap

Planned work is tracked in **[ROADMAP.md](ROADMAP.md)**, organised by feasibility
tier — whether a documented API surface actually exists to build on. In brief:

- 🟢 **Ready next:** sensitivity-label **write** and publishing (`New-/Set-Label`, `*-LabelPolicy`), plus DLP delete (`Remove-DlpCompliancePolicy/Rule`). *Changing a DLP policy's mode (`set_dlp_policy`) is now shipped.*
- 🟡 **Feasible but complex:** custom SIT write (requires hand-built rule-package XML), retention labels.
- 🔴 **Blocked:** trainable classifier catalog — no confirmed cmdlet or Graph API; portal-only today, needs live-tenant discovery first.
- 🔭 **New planes:** Insider Risk Management, Communications Compliance, DSPM / DSPM for AI.

See [ROADMAP.md](ROADMAP.md) for the full breakdown, the surface each item rests on, and the contribution rules.

## Credits

Developed by **[Securing the Realm](https://securing.quest/)** — Chris Lloyd-Jones (**Sealjay**) & Josh McDonald (**KnowledgeRatio**).

## License

MIT — see [LICENCE](LICENCE). If you fork, redistribute, or build on this, please retain the attribution above.
