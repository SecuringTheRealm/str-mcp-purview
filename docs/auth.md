# Authentication

## Authentication flow

The two auth planes sign in independently:

- **Graph:** `get_label_policy_settings` acquires a Microsoft Graph token via `@azure/identity` and caches it in memory.
- **PowerShell:** label configuration and DLP tools run `Connect-IPPSSession` inside a background `pwsh` child. That child is spawned with piped stdio and **no interactive console**, and `Connect-IPPSSession`'s own interactive sign-in (browser *or* WAM) requires a console — so it hangs. The server therefore signs in **here in Node** (which can), acquires a Security & Compliance access token, and passes it to `Connect-IPPSSession -AccessToken`. This is **token-injection mode**, and it is the default.

> **Why not just let `Connect-IPPSSession` sign in?** It can't from this server. A pwsh child launched by Node has no window station, so WAM fails with *"A window handle must be configured"* and the `-DisableWAM` browser fallback hangs forever. Interactive `Connect-IPPSSession` only works on a host that gives pwsh a real console — not this one.

### Local setup (default)

Follow the README: [register the app (step 1)](../README.md#1-register-the-microsoft-entra-app) and [provide the tenant and client IDs (step 4)](../README.md#4-provide-the-tenant-and-client-ids). The delegated `Exchange.ManageV2` permission (README step 1.4) is required: without it token acquisition fails with `AADSTS650057: Invalid resource`. It is a *different* permission from the app-only `Exchange.ManageAsApp` used by the [unattended paths](#unattended-and-hosted-setup) below; delegated and app-only are not interchangeable here.

The first DLP call does one interactive sign-in **in Node** (browser, or device code via `PURVIEW_AUTH_MODE=devicecode`) to acquire the token; the pwsh child connects silently with it, and the token refreshes automatically as it expires. Conditional Access, MFA and device compliance all still apply, because the token belongs to *you*.

### Unattended and hosted setup

Both planes take their token from the same credential, so an unattended host only has to change *which credential* — the bridge still connects the same way.

- **Managed identity** (`PURVIEW_AUTH_MODE=managedidentity`) — the platform mints the token without a stored secret. Supported by our Graph credential path; the compliance token-injection path remains deployment-specific and is not certified merely because Graph succeeds. Use the documented Windows certificate connection for a Microsoft-documented unattended compliance setup.
- **Certificate app-only** — for a non-Azure unattended host. On the PowerShell plane, `Connect-IPPSSession` reads the certificate from the **Windows certificate store by thumbprint** (`PURVIEW_APP_ID` + `PURVIEW_ORGANIZATION` + `PURVIEW_CERT_THUMBPRINT`); on the Graph plane, point `AZURE_CLIENT_CERTIFICATE_PATH` at the certificate file.

For Graph policy settings, grant the application permission `InformationProtectionPolicy.Read.All`. For Security & Compliance PowerShell, Microsoft's guide specifies **Microsoft Exchange Online Protection → Exchange.ManageAsApp** (resource app ID `00000007-0000-0ff1-ce00-000000000000`, role ID `455e5cd2-84e8-4751-8344-5672145dfa17`), with admin consent and an appropriate service-principal role assignment. **Office 365 Exchange Online** is a separate resource used by `Connect-ExchangeOnline`; granting that permission alone is not the documented compliance setup. Compliance Administrator is a documented role option; custom role groups can provide more targeted access. Endpoint restriction parameters specifically require Compliance Administrator or Compliance Data Administrator. See [Microsoft's app-only auth guide](https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2).

> **App-only auth is a real privilege trade.** Actions use the application's permissions, not the MCP caller's user permissions. User MFA is not performed for app-only operations; workload-identity controls and tenant policy must be considered separately. API consent does not replace RBAC, and the shared application identity does not automatically enforce each HTTP caller's Purview permissions. The server deliberately does not accept certificate passwords through environment variables. See [Microsoft's connection guidance](https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2#connection-examples).

Token injection checks for ExchangeOnlineManagement **3.8.0+** and the `AccessToken` parameter before connecting; native certificate/interactive connections require the REST-capable **3.2.0+** baseline. PowerShell 7.4 or 7.5 pairs with module 3.9.2 (7.5 is recommended, so ISO timestamps in text fields stay text); module 3.10+ requires PowerShell 7.6+. The experimental Linux container pins 7.5.12 with 3.9.2, but this does **not** remove Microsoft's Linux restriction on `Connect-IPPSSession`. [Module/platform requirements](https://learn.microsoft.com/powershell/exchange/exchange-online-powershell-v2#supported-operating-systems-for-the-exchange-online-powershell-module), [token parameter](https://learn.microsoft.com/powershell/module/exchangepowershell/connect-ippssession#-accesstoken).

The existing delegated token scope default is retained. For app-only token injection, the token audience, resource-specific consent and assigned roles must be verified together; `PURVIEW_EXO_SCOPE` is an override, not a permission grant. Do not infer an app-only audience from the delegated default or claim a successful HTTP/Graph test proves compliance access.

### Auth environment variables

| Variable | Plane | Default | Purpose |
| --- | --- | --- | --- |
| `PURVIEW_AUTH_MODE` | Both | `interactive` | `interactive`, `devicecode` or `managedidentity` (case-insensitive); any other value stops the server. `devicecode` signs in with a URL + code instead of a browser popup. `managedidentity` uses the host's managed identity (no secret at rest). Chooses the credential for **both** planes. |
| `AZURE_REDIRECT_URI` | Both | `http://localhost` | Redirect URI for the interactive browser flow. |
| `AZURE_CLIENT_CERTIFICATE_PATH` | Both | *(none)* | Switches the credential to **certificate app-only**. The Graph label-policy-settings read then uses the tenant-wide path and needs `InformationProtectionPolicy.Read.All`. |
| `PURVIEW_ORGANIZATION` | DLP | *(from token)* | Your `<tenant>.onmicrosoft.com` domain for `-Organization`. Derived from the token's `upn` claim if unset. |
| `PURVIEW_EXO_SCOPE` | DLP | `https://outlook.office365.com/.default` | Resource scope for the Security & Compliance access token. |
| `PURVIEW_DLP_AUTH_MODE` | DLP | `token` | `token` or `interactive` (case-insensitive); any other value stops the server. `token` injects a Node-acquired access token into `Connect-IPPSSession`, the only mode that works from this server. `interactive` lets pwsh sign in itself; see the warning above. |
| `PURVIEW_APP_ID` + `PURVIEW_CERT_THUMBPRINT` | DLP | *(none)* | With `PURVIEW_ORGANIZATION`, uses cmdlet-native certificate app-only auth (Windows cert store). |
| `PURVIEW_UPN` | DLP | *(none)* | Interactive mode only: pre-fills the account for `Connect-IPPSSession`. |
| `PURVIEW_ENABLE_WAM` | DLP | *(off)* | Interactive mode only: `1` uses the Windows WAM broker (needs a desktop host). |
| `PURVIEW_SIGNIN_TIMEOUT_MS` | DLP | the connect timeout (`60000` on the HTTP host) | Positive integer, otherwise the server stops. Bound on acquiring the access token in Node, i.e. how long an unanswered interactive sign-in can block the tool call. |
| `PURVIEW_CONNECT_TIMEOUT_MS` | DLP | `300000` (`90000` on the HTTP host) | Positive integer, otherwise the server stops. Timeout budget for the connect step in `pwsh` (module import + session handshake). Does not cover the sign-in above, which happens first. |
| `PURVIEW_EXEC_TIMEOUT_MS` | DLP | `60000` | Positive integer, otherwise the server stops. Per-cmdlet timeout once connected. On timeout the pwsh session is reset; the next call reconnects. |
| `PURVIEW_PWSH` | DLP | `pwsh` | Path to the PowerShell 7+ executable. |
| `PURVIEW_ALLOW_UNSUPPORTED_OS` | DLP | *(off)* | Set to `1` to attempt `Connect-IPPSSession` on macOS/Linux despite Microsoft not supporting it there. Needed in the [container image](hosting.md#container-image). |

> **`PURVIEW_DLP_AUTH_MODE=interactive` does not work on this server** and is not the default. It asks the `pwsh` child to run its own sign-in, but that child is spawned with piped stdio and has no console: WAM fails with *"A window handle must be configured"*, and the `-DisableWAM` browser fallback hangs until the connect timeout. It is retained only for a host that gives `pwsh` a real console.

### Troubleshooting sign-in

**The browser opens in the wrong profile.** Sign-in launches your **default** browser/profile. In Edge, set **Settings → Profiles → Profile preferences → Default profile for external links** to the admin profile. Or switch to device code (`PURVIEW_AUTH_MODE=devicecode`) and open the URL in whatever profile you like — the URL + code are written to the server's **stderr** (view it in your MCP host's server logs).

**DLP calls hang or time out.** Two causes, in order of likelihood. First, an interactive sign-in is waiting on a browser window you never saw open — complete it, or switch to `PURVIEW_AUTH_MODE=devicecode` and read the code from the server's stderr. Second, you are in interactive DLP mode on a console-less host — unset `PURVIEW_DLP_AUTH_MODE` to return to the default token mode.

**`AADSTS650057: Invalid resource`.** The app registration lacks the Office 365 Exchange Online permission; add it and grant consent ([README step 1.4](../README.md#1-register-the-microsoft-entra-app)).

**`Unexpected character encountered while parsing value: <`.** The Security & Compliance endpoint answered with an HTML error page instead of JSON, which is what a rejected or lapsed access token usually looks like from inside the module. The bridge reconnects and retries this automatically for read tools; for writes it surfaces the error rather than risk applying a change twice.

**`Cannot overwrite variable IsWindows because it is read-only or constant`.** Microsoft's [app-only auth guide](https://learn.microsoft.com/powershell/exchange/app-only-auth-powershell-v2) says to run `$Global:IsWindows = $true` before `Connect-IPPSSession` if it presents a sign-in prompt. That advice only applies to **Windows PowerShell 5.1**, where `$IsWindows` does not exist and the assignment creates an ordinary variable. This server requires **PowerShell 7**, where `$IsWindows` is a read-only automatic variable on every platform — so under the bridge's `$ErrorActionPreference = 'Stop'` the assignment kills the connect on its first line. Do not add it.
