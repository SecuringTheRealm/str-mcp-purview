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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "../src/server.js";

const PORT = Number(process.env.PORT || process.env.FUNCTIONS_CUSTOMHANDLER_PORT || 3000);
const MAX_BODY_BYTES = 4 * 1024 * 1024;

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

  try {
    const raw = await readBody(req);
    const body = raw ? JSON.parse(raw) : null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await createServer().connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" }).end(rpcError(-32603, "Internal server error"));
    }
  }
});

http.listen(PORT, () => {
  console.log(`str-mcp-purview streamable HTTP listening on http://localhost:${PORT}/mcp`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
