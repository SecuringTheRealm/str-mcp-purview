# str-mcp-purview

> A local MCP server that lets AI agents read and write Microsoft Purview **data security** configuration — sensitivity labels and DLP policies — as the signed-in admin.

![GitHub issues](https://img.shields.io/github/issues/SecuringTheRealm/str-mcp-purview)
![GitHub](https://img.shields.io/github/license/SecuringTheRealm/str-mcp-purview)
[![Node](https://img.shields.io/badge/node-%3E%3D18-3178C6?logo=node.js&logoColor=ffffff)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-3178C6)](https://modelcontextprotocol.io/)

This is a ground-up rewrite (v2). The original server targeted the **Azure Purview** data-catalog SDKs and returned mocked data. This version targets the **Microsoft 365 / Microsoft Purview compliance** surface with real API calls, designed for coding agents (Claude Code, VS Code / GitHub Copilot) running locally.

## Why a hybrid design

The modern Purview developer surface is split across planes, and no single one covers read *and* write for data-security config:

| Plane | Used for | R/W here |
| --- | --- | --- |
| **Microsoft Graph** (`/beta/security/informationProtection`) | Sensitivity label discovery & policy settings | Read |
| **Security & Compliance PowerShell** (`Connect-IPPSSession`) | DLP policy & rule CRUD — *not exposed through Graph* | Read + Write |

So this server is a **hybrid**: raw Microsoft Graph calls for labels, and a persistent PowerShell bridge (`ExchangeOnlineManagement` → `Get/New/Set-DlpCompliance*`) for DLP. Both act as the **delegated signed-in admin**, so every action honours that admin's Purview RBAC.

> Scope of v1: **sensitivity labels (read)** and **DLP policies (read/write)**. Insider Risk Management, Communications Compliance, and DSPM are planned follow-ups.

## Prerequisites

- **Node.js 18+**
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

### `list_sensitivity_labels`

Queries Microsoft Graph. Returns one line per label: label ID, sensitivity order, active/inactive state, name (and parent, if any), and a short description. Use this first to find the `label_id` needed by `get_sensitivity_label`.

*No parameters.*

---

### `get_sensitivity_label`

Queries Microsoft Graph for a single label and returns a structured markdown report: sensitivity order, active state, colour, tooltip, description, and parent label.

| Parameter | Type | Description |
|-----------|------|-------------|
| `label_id` | string | Sensitivity label GUID, from `list_sensitivity_labels` |

---

### `get_label_policy_settings`

Queries Microsoft Graph for the Information Protection label policy settings that apply to the signed-in admin. Returns markdown covering whether labeling is mandatory, whether downgrade justification is required, and the default label.

*No parameters.*

---

### `list_dlp_policies`

Queries Security & Compliance PowerShell (`Get-DlpCompliancePolicy`). Returns one line per policy: name, mode/state, workload, and creation date. Output is trimmed to key properties to keep it lean.

*No parameters.*

---

### `get_dlp_policy`

Queries `Get-DlpCompliancePolicy` for a single policy and returns a structured markdown report: GUID, mode, enabled state, workload, type, comment, and creation metadata.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | DLP policy name or GUID |

---

### `list_dlp_rules`

Queries `Get-DlpComplianceRule`. Returns one line per rule: name, enabled/disabled state, priority, parent policy, whether it blocks access, and any detected sensitive information types.

| Parameter | Type | Description |
|-----------|------|-------------|
| `policy` | string | Optional — restrict to rules in this DLP policy (name or GUID) |

---

### `create_dlp_policy`

**Write operation.** Creates a new DLP policy container (`New-DlpCompliancePolicy`). Add rules afterwards with `create_dlp_rule`. Prefer a Test mode before enabling enforcement.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Unique policy name |
| `mode` | string | Policy mode: `Enable`, `TestWithNotifications`, `TestWithoutNotifications`, `Disable` (default `Enable`) |
| `comment` | string | Optional description/comment |
| `exchange_location` | string[] | Exchange locations, e.g. `["All"]` |
| `sharepoint_location` | string[] | SharePoint locations, e.g. `["All"]` |
| `onedrive_location` | string[] | OneDrive locations, e.g. `["All"]` |

---

### `create_dlp_rule`

**Write operation.** Creates a DLP rule inside a policy (`New-DlpComplianceRule`). A rule needs at least one condition and one action.

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

### `set_dlp_rule`

**Write operation.** Modifies an existing DLP rule (`Set-DlpComplianceRule`). Only the fields you supply change.

| Parameter | Type | Description |
|-----------|------|-------------|
| `identity` | string | Rule name or GUID to modify |
| `block_access` | boolean | Set the block-access action |
| `notify_user` | string[] | Replace the notify-user list |
| `generate_alert` | boolean | Set alert generation |
| `priority` | integer | Set rule priority |
| `disabled` | boolean | Enable (`false`) or disable (`true`) the rule |

> **Write operations change tenant configuration.** Run them against a test tenant first, and prefer creating policies in a Test mode before enabling enforcement.

## Prompts

Prompts are pre-defined workflows that chain multiple tool calls and instruct the model to produce a structured report. In VS Code they are available via the Copilot Chat prompt picker. Both are read-only analyses — they make no changes.

### `dlp-policy-review`

Full review of the tenant's DLP posture. Calls `list_dlp_policies` and `list_dlp_rules`, then produces a report covering a summary of policies and rules, workload coverage, gaps and risks (test-mode policies, disabled rules, rules that detect sensitive information but take no blocking action), and prioritised recommendations.

*No arguments.*

---

### `label-coverage-audit`

Audit of sensitivity-label usage across DLP. Calls `list_sensitivity_labels`, `get_label_policy_settings`, and `list_dlp_rules`, then produces a report covering the label inventory, policy settings, which labels are (and are not) referenced by DLP rules, and recommendations.

*No arguments.*

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

- Insider Risk Management (Microsoft Graph Security API — alerts/incidents, advanced hunting)
- Communications Compliance policies
- DSPM / DSPM for AI posture
- Sensitivity-label **write** (publish/apply) and retention labels

## License

MIT — see [LICENCE](LICENCE).
