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

Every delete tool requires form elicitation confirmation, and the shipped host supplies no trusted caller identity, so **deletes are refused on it** (fail closed, even with a function key). Deletion works over stdio; see [Elicitation for deletion confirmation](design.md#elicitation-for-deletion-confirmation). The five catalog list tools and policy-scoped `get_dlp_rule` default to 25 items (maximum 100), return signed opaque keyset cursors, and include schema-backed `structuredContent` with page count, total count, `has_more`, and `next_cursor` alongside concise text. The same pagination contract is served over local stdio and Azure Functions HTTP. Set a shared `MCP_CURSOR_SECRET` on every scaled HTTP instance so a cursor issued by one instance works on another.

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
| `MCP_CURSOR_SECRET` | random per process | Signs pagination cursors. Required on Azure Functions; set the same value on every scaled instance. |
| `MCP_MAX_CONCURRENT_REQUESTS` | `8` | Positive integer; requests over the limit get 429 with `retry-after: 1`. |
| `MCP_REQUEST_LOGGING` | on | `false` turns off the per-request stderr record. |
