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
- **Technical:** `GET /beta/security/informationProtection/sensitivityLabels` via Microsoft Graph, as the delegated admin. Returns one compact line per label: label ID, sensitivity order, active/inactive state, name (and parent, if a sub-label), and a truncated description.

*No parameters.*

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

### DLP policies & rules — Security & Compliance PowerShell

#### `list_dlp_policies`

- **Business:** Get an at-a-glance inventory of the tenant's Data Loss Prevention policies — the containers that decide *where* protection applies (Exchange, SharePoint, etc.) and whether each is live-enforcing, in test, or off.
- **Technical:** `Get-DlpCompliancePolicy` in the persistent `Connect-IPPSSession` bridge. Output is trimmed to key properties (name, mode/state, workload, creation date) — one line per policy — to stay token-lean.

*No parameters.*

---

#### `get_dlp_policy`

- **Business:** Inspect one DLP policy in full — its enforcement mode, which workloads it covers, who created it and when — before deciding whether to change or enforce it.
- **Technical:** `Get-DlpCompliancePolicy -Identity <name|GUID>`. Returns a structured markdown report: GUID, mode, enabled state, workload, type, comment, and creation metadata.

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

> **Write operations change tenant configuration.** Run them against a test tenant first, and prefer creating policies in a Test mode before enabling enforcement.

---

### Sensitive information types — Security & Compliance PowerShell (read-only)

#### `list_sensitive_information_types`

- **Business:** Look up the exact catalogue of detectable data types — built-in Microsoft ones (credit card numbers, SSNs, passport numbers…) plus any custom types your org has defined. You need the precise name from here to reference a type when building a DLP rule.
- **Technical:** `Get-DlpSensitiveInformationType`. One line per SIT: name, built-in/custom, and a short description. Custom SITs are identified by `Publisher` being something other than `Microsoft Corporation` (per Microsoft's documented convention). Does **not** include trainable classifiers — see [ROADMAP.md](ROADMAP.md).

| Parameter | Type | Description |
|-----------|------|--------------|
| `scope` | string | `all` (default) or `custom` — restrict to the org's own SITs |

## Prompts

Prompts are pre-defined workflows that chain multiple tool calls and instruct the model to produce a structured report. In VS Code they are available via the Copilot Chat prompt picker. Both are read-only analyses — they make no changes.

### `dlp-policy-review`

Full review of the tenant's DLP posture. Calls `list_dlp_policies` and `list_dlp_rules`, then produces a report covering a summary of policies and rules, workload coverage, gaps and risks (test-mode policies, disabled rules, rules that detect sensitive information but take no blocking action), and prioritised recommendations.

*No arguments.*

---

### `label-coverage-audit`

Audit of sensitivity-label usage across DLP. Calls `list_sensitivity_labels`, `get_label_policy_settings`, and `list_dlp_rules`, then produces a report covering the label inventory, policy settings, which labels are (and are not) referenced by DLP rules, and recommendations.

*No arguments.*

## Resources

Resources are user/host-attached context, distinct from tools: instead of the model calling them mid-reasoning, a user (or a host that supports it) attaches them directly to a conversation. Both resources below are backed by the same data as `list_sensitive_information_types`, live-queried on every read (no caching).

| URI | Description |
|-----|--------------|
| `purview://sit-catalog` | All sensitive information types visible to the tenant — built-in and custom. |
| `purview://sit-catalog/custom` | Only the org's custom sensitive information types. |

## Typical workflows

**Inspect a sensitivity label you have heard about:**
> Call `list_sensitivity_labels`, then `get_sensitivity_label` with the ID returned.

**Understand your DLP posture:**
> Use the `dlp-policy-review` prompt with no arguments.

**Check which labels lack DLP coverage:**
> Use the `label-coverage-audit` prompt with no arguments.

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
