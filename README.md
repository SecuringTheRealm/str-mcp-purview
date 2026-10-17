# str-mcp-purview

> An MCP server that lets AI agents read and write Microsoft Purview **data security** configuration (sensitivity labels and DLP policies) as the signed-in admin. Runs locally over stdio, or remotely over streamable HTTP.

![GitHub issues](https://img.shields.io/github/issues/SecuringTheRealm/str-mcp-purview)
![GitHub](https://img.shields.io/github/license/SecuringTheRealm/str-mcp-purview)
[![Node](https://img.shields.io/badge/node-%3E%3D20-3178C6?logo=node.js&logoColor=ffffff)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-3178C6)](https://modelcontextprotocol.io/)

Ask your coding agent (Claude Code, VS Code / GitHub Copilot) things like:

- "Run `/data-security-posture` for a UK insurer and tell me where our labels never reach a DLP control."
- "Which DLP policies are still in test mode, and since when?"
- "Draft a Copilot DLP policy in test mode that blocks prompts containing card numbers."

Every call runs as you, so your Purview RBAC, MFA and Conditional Access still apply. Deletes always ask you to confirm in a form first.

## What it covers

| Plane | Used for | Read / write |
| --- | --- | --- |
| **Security & Compliance PowerShell** (`Connect-IPPSSession`) | Sensitivity labels, label policies, auto-labelling, DLP (including Endpoint and Copilot), sensitive information types | Read + write |
| **Microsoft Graph** (`/beta/security/informationProtection`) | Per-user label policy settings | Read |

Insider Risk, Communications Compliance and DSPM are not covered yet; see [ROADMAP.md](ROADMAP.md).

## Platform support

**Windows-first.** 36 of the 37 tools run through Security & Compliance PowerShell, which Microsoft [does not support in PowerShell 7 on macOS or Linux](https://learn.microsoft.com/powershell/exchange/exchange-online-powershell-v2#supported-operating-systems-for-the-exchange-online-powershell-module). On macOS/Linux those tools fail fast with a clear error, and only the Graph-backed `get_label_policy_settings` works. `PURVIEW_ALLOW_UNSUPPORTED_OS=1` skips the gate if a future module release changes that.

| Platform | Label policy settings (Graph) | Labels, auto-labelling and DLP (PowerShell) |
| --- | --- | --- |
| Windows | ✅ | ✅ |
| macOS / Linux | ✅ | ❌ (Microsoft-unsupported; gated) |

## Prerequisites

- **Node.js 20+**.
- **Windows with PowerShell 7+** and the Exchange Online module:
  ```powershell
  Install-Module ExchangeOnlineManagement -RequiredVersion 3.9.2 -Scope CurrentUser
  ```
- A **Microsoft 365 tenant** where you (or an admin) can register an app and grant consent.
- An **admin account** with the Purview role for the tools you'll use (step 2).

## Setup

One Entra app registration backs both planes. It is a **public client**: no secret or certificate is created. The server signs you in from Node and hands the token to PowerShell, so the DLP tools need the app registration too ([why](docs/auth.md)).

### 1. Register the Microsoft Entra app

In the [Entra admin center](https://entra.microsoft.com) → **Identity → Applications → App registrations → New registration**:

1. Name it (e.g. `str-mcp-purview`), single tenant.
2. **Redirect URI**: platform **Public client/native**, value `http://localhost` (no port; Entra accepts any loopback port).
3. **Authentication → Advanced settings → Allow public client flows → Yes** (needed for device-code sign-in).
4. **API permissions → Add a permission**:
   - **Microsoft Graph → Delegated → `InformationProtectionPolicy.Read`**
   - **APIs my organization uses → Office 365 Exchange Online → Delegated → expand *Exchange* → `Exchange.ManageV2`**
5. **Grant admin consent** and check both rows show **✔ Granted**.
6. Copy the **Application (client) ID** and **Directory (tenant) ID** from **Overview**.

### 2. Give the sign-in account its Purview roles

| Tools | Minimum role |
|---|---|
| Labels and label policies | *Information Protection Admin* or *Compliance Administrator* |
| DLP | *DLP Compliance Management* or *Compliance Administrator* |
| Everything | *Compliance Administrator* |

Assign roles in the **Purview portal → Settings → Roles & scopes → Role groups**.

### 3. Install

```bash
git clone https://github.com/SecuringTheRealm/str-mcp-purview.git
cd str-mcp-purview
npm install
```

### 4. Provide the tenant and client IDs

The server reads `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `PURVIEW_ORGANIZATION` (`<tenant>.onmicrosoft.com`, derived from your sign-in if unset) from the process environment. **A `.env` file is not loaded.** Put them in the MCP config `env` block below (they are not secrets), or set them as Windows user environment variables and reopen your terminal:

```powershell
[System.Environment]::SetEnvironmentVariable("AZURE_TENANT_ID", "<tenant-id>", "User")
[System.Environment]::SetEnvironmentVariable("AZURE_CLIENT_ID", "<client-id>", "User")
```

Every other variable is optional; see [docs/auth.md](docs/auth.md#auth-environment-variables).

### 5. Register the server with your MCP host

**Claude Code**: `.mcp.json` in your workspace (see [`.mcp.json.example`](.mcp.json.example)). **VS Code / GitHub Copilot**: `.vscode/mcp.json`, with `"servers"` instead of `"mcpServers"` and `${workspaceFolder}/index.js` as the path.

```json
{
  "mcpServers": {
    "purview": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/str-mcp-purview/index.js"],
      "env": {
        "AZURE_TENANT_ID": "<tenant-id>",
        "AZURE_CLIENT_ID": "<client-id>",
        "PURVIEW_ORGANIZATION": "<tenant>.onmicrosoft.com",
        "PURVIEW_TOOL_MODE": "compact"
      }
    }
  }
}
```

Restart the host. `compact` advertises 8 tools instead of 37 (see [Tool modes](#tool-modes)).

### First run

1. Ask the agent to call `purview_auth` (or `get_auth_status`). It reports what is configured without signing in.
2. Ask "list my DLP policies". The first PowerShell-backed call opens a browser sign-in. For a URL and code instead, set `PURVIEW_AUTH_MODE=devicecode`; they appear in the host's server log (stderr).
3. The pwsh session then connects silently and refreshes its token itself. Later calls are quick.

## Tool modes

`PURVIEW_TOOL_MODE` changes what the agent sees, not what it can do: every mode uses the same handlers, validation and auth.

| Mode | Tools advertised | Approx. `tools/list` size | Use |
| --- | ---: | ---: | --- |
| `full` (default) | 37 | ~21k tokens | Existing clients, detailed schemas up front |
| `compact` | 8 | ~1.5k tokens | **Recommended.** Search → describe → execute, with read and write tools kept separate for approval rules |
| `dispatcher` | 3 | ~0.5k tokens | Smallest surface |

Full mode stays the default so existing tool names don't change. The full tool reference, the compact workflow and capability policies are in [docs/tools.md](docs/tools.md).

## Prompts and resources

- **`data-security-posture`**: traces define → reference → enforce → cover across labels, SITs and DLP and reports where protection breaks. Optional `business_context`.
- **`dlp-control-review`**: DLP drill-down covering enforcement readiness, rule conflicts, scope and alerting. Optional `policy`.
- Resources `purview://label-catalog`, `purview://sit-catalog` and `purview://sit-catalog/custom` attach the classification vocabulary to a conversation.

Both prompts are read-only. Details: [docs/tools.md](docs/tools.md#prompts).

## Safety

- Every action runs as the signed-in admin and is limited by that account's Purview RBAC.
- **Deletes** always show a confirmation form naming the tenant and the resolved object. Declining, cancelling, or a client without form support means nothing is deleted. `confirm: true` cannot skip it ([how it works](docs/design.md#elicitation-for-deletion-confirmation)).
- `PURVIEW_READ_ONLY`, `PURVIEW_ALLOWED_CAPABILITIES` and related settings restrict what the server will run ([capability policies](docs/tools.md#capability-policies-and-retrieval)).
- Creates and sets apply immediately. Create DLP policies in `TestWithNotifications` first and promote them once you've checked their impact.
- Tenant data in results is untrusted input to the model. Review changes an agent proposes before approving them.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "need Security & Compliance PowerShell ... only supports Windows" | Expected on macOS/Linux; see [Platform support](#platform-support). |
| DLP call hangs | A sign-in window is waiting unseen. Finish it, or set `PURVIEW_AUTH_MODE=devicecode` and read the code from stderr. |
| Browser opens the wrong profile | Set your admin profile as the default for external links, or use device code. |
| `AADSTS650057: Invalid resource` | The app lacks `Exchange.ManageV2`; redo step 1.4 and grant consent. |
| `Unexpected character ... parsing value: <` | An expired or rejected token. Reads retry automatically; re-run writes after checking state. |
| "Auth is not configured" | `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` are not in the server's environment. |

More in [docs/auth.md](docs/auth.md#troubleshooting-sign-in).

## Test

```bash
npm test
```

Uses Node's built-in `node:test` (no framework dependency), including real stdio and HTTP round trips in both MCP protocol eras.

## More documentation

| Doc | Contents |
| --- | --- |
| [docs/auth.md](docs/auth.md) | Sign-in flow, unattended and app-only auth, every auth variable, troubleshooting |
| [docs/tools.md](docs/tools.md) | All 37 tools, tool modes, DLP write corrections, capability policies, prompts, resources, workflows |
| [docs/hosting.md](docs/hosting.md) | Azure Functions and container hosting (in UAT), endpoint security, pagination, logging |
| [docs/design.md](docs/design.md) | Architecture, extending the catalogue, deletion confirmation, auto-labelling, requirement-elicitation proposal |
| [SECURITY.md](SECURITY.md) / [ROADMAP.md](ROADMAP.md) | Reporting and remote-hosting guidance / delivery outcomes and status |

## Credits

Developed by **[Securing the Realm](https://securing.quest/)**: Chris Lloyd-Jones (**Sealjay**) and Josh McDonald (**KnowledgeRatio**).

## License

MIT, see [LICENCE](LICENCE). If you fork, redistribute or build on this, please retain the attribution above.
