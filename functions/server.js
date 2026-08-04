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
// See README → "Hosting on Azure Functions". Endpoint access itself is gated
// by the Functions key (host.json DefaultAuthorizationLevel "function"); use
// built-in auth (Easy Auth) as well for anything beyond a demo.

import { createServer as createHttpServer } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createServer } from "../src/server.js";

const PORT = Number(process.env.PORT || process.env.FUNCTIONS_CUSTOMHANDLER_PORT || 3000);
const HOST = process.env.MCP_HTTP_HOST || (process.env.FUNCTIONS_CUSTOMHANDLER_PORT ? "0.0.0.0" : "127.0.0.1");
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = Number(process.env.MCP_MAX_CONCURRENT_REQUESTS || 8);
let activeRequests = 0;
const allowedOrigins = new Set(
  (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const mcpHandler = createMcpHandler(createServer, { responseMode: "json" });
const handleMcp = toNodeHandler(mcpHandler);

function rpcError(code, message) {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const http = createHttpServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

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
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    res.writeHead(415, { "content-type": "application/json" }).end(rpcError(-32600, "Content-Type must be application/json."));
    return;
  }
  const accept = String(req.headers.accept ?? "").toLowerCase();
  if (accept && !accept.includes("application/json") && !accept.includes("text/event-stream") && !accept.includes("*/*")) {
    res.writeHead(406, { "content-type": "application/json" }).end(rpcError(-32600, "Accept must allow application/json or text/event-stream."));
    return;
  }
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    res.writeHead(413, { "content-type": "application/json" }).end(rpcError(-32600, "Request body too large."));
    return;
  }
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1" }).end(rpcError(-32000, "Server is busy. Retry after one second."));
    return;
  }

  activeRequests += 1;
  try {
    const raw = await readBody(req);
    let body;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      res.writeHead(400, { "content-type": "application/json" }).end(rpcError(-32700, "Malformed JSON request body."));
      return;
    }
    await handleMcp(req, res, body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" }).end(rpcError(-32603, "Internal server error"));
    }
  } finally {
    activeRequests -= 1;
  }
});

http.listen(PORT, HOST, () => {
  console.log(`str-mcp-purview streamable HTTP listening on http://${HOST}:${PORT}/mcp`);
});

async function shutdown() {
  await mcpHandler.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
