# Hosting on Azure Functions

> **Status: In UAT.** The HTTP host supports the same tool modes, two prompts, and three resources as stdio (37 tools in unrestricted full mode). Local transport/protocol tests pass. Azure Functions is not production-validated until every Graph- and PowerShell-backed operation passes the deployed disposable-object UAT suite.

The custom handler (`host.json`) launches `functions/server.js` and serves stateless MCP at `POST /mcp`. One canonical factory in `src/server.js` backs both transports.

| Transport | Legacy 2025 clients | MCP `2026-07-28` |
| --- | --- | --- |
| stdio | Tested locally | Tested locally (`server/discover`, no modern `initialize`) |
| HTTP / Functions custom handler | Tested locally | Tested locally through the Node adapter; deployed Azure proxy validation remains In UAT |

Two deployment shapes:

| Shape | Plan | Tool surface |
| --- | --- | --- |
| **Code-only** (`func`/zip deploy of this repo) | Flex Consumption | Advertises the canonical full surface; PowerShell execution remains UAT-dependent |
| **Container** ([`Containerfile`](../Containerfile)) | Elastic Premium / Dedicated / Azure Container Apps | Advertises the canonical full surface; tenant connectivity and all-tool execution remain In UAT |

Remote hosting is headless, so use a renewable app identity and configure the Graph and PowerShell planes independently. Managed identity and certificate combinations are deployment candidates, not claimed as fully supported until the UAT authentication matrix proves every backend operation, including the separate auto-label simulation session.

**Secure the endpoint.** A function key is not sufficient production caller authentication. Put Entra/Easy Auth in front, validate its token audience and allowed client applications, and scope backend permissions tightly. Set `MCP_ALLOWED_HOSTS` to the comma-separated public hostnames accepted through the Azure proxy, `MCP_ALLOWED_ORIGINS` to a comma-separated browser-origin allowlist, `MCP_CURSOR_SECRET` to a shared secret for multi-instance pagination, and optionally `MCP_MAX_CONCURRENT_REQUESTS` (default `8`). Localhost Host values are accepted only when the listener is loopback-only (or behind the Functions host); on any other bind list them in `MCP_ALLOWED_HOSTS`, which is then required (the server will not start without it). Missing `Origin` remains valid for non-browser clients, while a present unlisted origin receives 403. Local smoke test: `node functions/server.js`, then POST MCP JSON-RPC to `http://127.0.0.1:3000/mcp`.

## Startup and settings

`functions/server.js` builds one server before it listens, as `index.js` does on stdio, so a bad setting stops the process with a message naming it rather than failing every request with a 500. That covers every numeric, enum, boolean and secret setting in the tables below and in [tools.md](tools.md#environment-variables) and [auth.md](auth.md#auth-environment-variables). The HTTP host also tightens three PowerShell limits so a call finishes inside the Functions front door (about 230 seconds); stdio keeps 300000 ms to connect and an unlimited queue. Set any of them to override.

## Deleting over HTTP

Every delete tool requires form elicitation confirmation bound to a trusted caller. Two things must both hold, or the delete is refused (fail closed, even with a function key):

1. **A verified caller.** Turn on App Service Authentication (Easy Auth) with Entra ID and "require authentication", then set `MCP_TRUST_EASY_AUTH=true`. The host reads the validated `X-MS-CLIENT-PRINCIPAL` header, binds the confirmation to the caller's object ID and client ID, and returns 401 without it or for another tenant. It refuses to start if Easy Auth is not enabled (`WEBSITE_AUTH_ENABLED`) or `AZURE_TENANT_ID` is unset.
2. **An MCP `2026-07-28` client with form elicitation.** 2025-era stateless HTTP carries no client capabilities, so a form cannot be requested and deletes from such a client are always refused.

The refusal names the cause, checked in this order: caller identity, form support, tenant (`AZURE_TENANT_ID` or `PURVIEW_ORGANIZATION` must be set so the form can name it). Deletion always works over stdio; see [Elicitation for deletion confirmation](design.md#elicitation-for-deletion-confirmation).

## Scale-out, pagination and logging

Pending deletion confirmations and the auto-label simulation record that gates `set_auto_label_policy` with `mode:"Enable"` live in one process's memory. On a scaled-out HTTP host, run deletes and auto-label Enable against a single instance (or sticky sessions) until that state is shared; a retry that lands on another instance fails safely.

The five catalog list tools and policy-scoped `get_dlp_rule` default to 25 items (maximum 100), return signed opaque keyset cursors, and include schema-backed `structuredContent` with page count, total count, `has_more`, and `next_cursor` alongside concise text. The same pagination contract is served over local stdio and Azure Functions HTTP. Set a shared `MCP_CURSOR_SECRET` (at least 32 characters) on every scaled HTTP instance so a cursor issued by one instance works on another.

Waiting writes are bounded by `PURVIEW_MAX_QUEUED_COMMANDS` too, and a write whose caller has cancelled never starts. Over the limit, a call fails with `BUSY` (`retryable: true`; nothing was sent). See [error codes](tools.md#error-codes).

Each MCP request emits one redacted structured completion record to stderr (captured by Azure application logging), including transport, protocol era/version, method or tool name, client identity metadata, trace context, duration, and outcome. Arguments, results, tokens, backend error messages, and tenant objects are not logged. Set `MCP_REQUEST_LOGGING=false` only when platform-level observability fully replaces these records.

## HTTP host environment variables

Read by `functions/server.js` (and `src/pagination.js` / `src/request-logging.js` where noted). Auth variables are in [auth.md](auth.md#auth-environment-variables); capability policy and tool-mode variables are in [tools.md](tools.md#environment-variables).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `FUNCTIONS_CUSTOMHANDLER_PORT`, else `3000` | Listening port. |
| `FUNCTIONS_CUSTOMHANDLER_PORT` | *(unset)* | Set by the Functions host. Also makes the bind `0.0.0.0`, trusts loopback Host values and makes `MCP_CURSOR_SECRET` mandatory. |
| `MCP_HTTP_HOST` | `0.0.0.0` when `FUNCTIONS_CUSTOMHANDLER_PORT` is set, else `127.0.0.1` | Bind address. |
| `MCP_ALLOWED_HOSTS` | *(none)* | Comma-separated Host names accepted. Required unless the listener is loopback-only; the server will not start without it. |
| `MCP_ALLOWED_ORIGINS` | *(none)* | Comma-separated browser-origin allowlist. A missing `Origin` is accepted; a present unlisted one gets 403. |
| `MCP_CURSOR_SECRET` | random per process | Signs pagination cursors. At least 32 characters or the server stops. Required on Azure Functions; set the same value on every scaled instance. |
| `MCP_MAX_CONCURRENT_REQUESTS` | `8` | Positive integer, otherwise the server stops. Requests over the limit get 429 with `retry-after: 1`. |
| `MCP_REQUEST_LOGGING` | on | `true`/`false`, `1`/`0` or `yes`/`no`; anything else stops the server. `false` turns off the per-request stderr record. |
| `MCP_TRUST_EASY_AUTH` | `false` | `true`/`false` (also `1`/`0`, `yes`/`no`). `true` trusts App Service Authentication's `X-MS-CLIENT-PRINCIPAL` for caller identity, requires a caller from `AZURE_TENANT_ID` on every request (401 otherwise), and allows deletes from MCP `2026-07-28` clients. The host refuses to start unless App Service sets `WEBSITE_AUTH_ENABLED` and `AZURE_TENANT_ID` is set. |
| `PURVIEW_MAX_QUEUED_COMMANDS` | `3` | Positive integer. PowerShell commands and write capabilities allowed to wait behind the running one; more get `BUSY`. Stdio default is unlimited. |
| `PURVIEW_SIGNIN_TIMEOUT_MS` | `60000` | Positive integer. Bound on acquiring the access token in Node ([auth.md](auth.md#auth-environment-variables)). |
| `PURVIEW_CONNECT_TIMEOUT_MS` | `90000` | Positive integer. Bound on the `pwsh` connect step; stdio default is `300000`. |

## Container image

The [`Containerfile`](../Containerfile) installs PowerShell 7.5 and `ExchangeOnlineManagement` 3.9.2 on Linux, where Microsoft does not support Security & Compliance PowerShell. The server therefore refuses PowerShell-backed tools until you set `PURVIEW_ALLOW_UNSUPPORTED_OS=1` in the container's application settings, once you have checked the connection against a live tenant. Graph-backed `get_label_policy_settings` and `get_auth_status` work without it.

`.containerignore` and `.dockerignore` keep `.git`, `.github`, `.env*`, `.mcp.json`, `local.settings.json`, `artifacts`, `scripts`, `test`, `docs`, `benchmarks`, `node_modules` and `*.md` out of the image, so local secrets and tenant data are never copied in.
