// Azure Functions (custom handler) host — serves the same Purview tool
// surface as the stdio entry point, over stateless streamable HTTP.
//
// Pattern follows Azure-Samples/mcp-sdk-functions-hosting-node: one POST /mcp
// endpoint; a fresh Server + StreamableHTTPServerTransport per request so
// concurrent clients cannot collide on request IDs; no SSE, no sessions.
//
// Auth in this hosting mode must be app-only (no human to sign in):
//   Graph — AZURE_CLIENT_CERTIFICATE_PATH (+ AZURE_TENANT_ID/AZURE_CLIENT_ID).
//   DLP/label-write — PURVIEW_APP_ID + PURVIEW_ORGANIZATION + PURVIEW_CERT_*.
// See docs/hosting.md. Endpoint access itself is gated
// by the Functions key (host.json DefaultAuthorizationLevel "function"); use
// built-in auth (Easy Auth) as well for anything beyond a demo.

import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { hostHeaderValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createServer } from "../src/server.js";

const PORT = Number(process.env.PORT || process.env.FUNCTIONS_CUSTOMHANDLER_PORT || 3000);
const HOST = process.env.MCP_HTTP_HOST || (process.env.FUNCTIONS_CUSTOMHANDLER_PORT ? "0.0.0.0" : "127.0.0.1");
const MAX_BODY_BYTES = 4 * 1024 * 1024;
if (process.env.FUNCTIONS_CUSTOMHANDLER_PORT && !process.env.MCP_CURSOR_SECRET) {
  throw new Error("MCP_CURSOR_SECRET is required on Azure Functions so pagination cursors work across scaled instances.");
}
const configuredConcurrency = Number(process.env.MCP_MAX_CONCURRENT_REQUESTS || 8);
if (!Number.isSafeInteger(configuredConcurrency) || configuredConcurrency < 1) {
  throw new Error("MCP_MAX_CONCURRENT_REQUESTS must be a positive integer.");
}
const MAX_CONCURRENT_REQUESTS = configuredConcurrency;
let activeRequests = 0;
// Loopback Host values are trusted only when nothing but this machine (or the
// Azure Functions host, which proxies to the custom handler over loopback) can
// reach the listener. On any other bind, a caller could send `Host: localhost`
// to step around MCP_ALLOWED_HOSTS, so loopback names must be listed there.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const loopbackOnly =
  Boolean(process.env.FUNCTIONS_CUSTOMHANDLER_PORT) ||
  ["127.0.0.1", "::1", "localhost"].includes(HOST);
const allowedHosts = [
  ...(loopbackOnly ? LOOPBACK_HOSTS : []),
  ...(process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean),
];
if (allowedHosts.length === 0) {
  throw new Error(`MCP_ALLOWED_HOSTS is required when listening on ${HOST}; without it every request is refused.`);
}
const validateHost = hostHeaderValidation([...new Set(allowedHosts)]);
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
// Build one server now, so a bad setting such as PURVIEW_TOOL_MODE fails at
// startup rather than as an opaque 500 on every request.
createServer({ transport: "http" });
const mcpHandler = createMcpHandler(
  (context) => createServer({ ...context, transport: "http" }),
  { responseMode: "json" }
);
const handleMcp = toNodeHandler(mcpHandler, { maxRequestBodySize: MAX_BODY_BYTES });

function rpcError(code, message) {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}

async function handle(req, res) {
  if (!validateHost(req, res)) return;
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(rpcError(-32600, "Malformed request URL."));
    return;
  }

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" }).end(rpcError(-32000, "Not found. POST to /mcp."));
    return;
  }
  if (req.method !== "POST") {
    // No SSE or session termination in stateless mode.
    res.writeHead(405, { "content-type": "application/json" }).end(rpcError(-32000, "Method not allowed."));
    return;
  }

  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) {
    res.writeHead(403, { "content-type": "application/json" }).end(rpcError(-32000, "Origin is not allowed."));
    return;
  }
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end(rpcError(-32000, "Server is busy. Retry after one second."));
    return;
  }

  // The SDK handler checks Content-Type (415), Accept (406), body size (413)
  // and JSON syntax (400) itself.
  activeRequests += 1;
  try {
    await handleMcp(req, res);
  } finally {
    activeRequests -= 1;
  }
}

// A client gets 30 seconds to send its whole request (Node's default is 5
// minutes); headersTimeout must not exceed it or it wins. Responses are not bound.
const http = createHttpServer({ requestTimeout: 30_000, headersTimeout: 15_000 }, (req, res) => {
  // Any failure ends this request with a 500; none can take the process down.
  handle(req, res).catch((err) => {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" }).end(rpcError(-32603, "Internal server error"));
    } else {
      res.destroy();
    }
  });
});

http.listen(PORT, HOST, () => {
  console.log(`str-mcp-purview streamable HTTP listening on http://${HOST}:${PORT}/mcp`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([
    mcpHandler.close(),
    new Promise((resolve, reject) => {
      http.close((err) => (err ? reject(err) : resolve()));
    }),
  ]);
}

// Exit explicitly: a live pwsh child keeps the event loop open, and exiting
// closes its stdin, which ends it.
// A half-open request would hold close() open, so stop waiting after 10 s.
const stop = () => {
  setTimeout(() => process.exit(0), 10_000).unref();
  void shutdown().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
