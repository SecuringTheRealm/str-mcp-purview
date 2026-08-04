import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, PROMPTS, RESOURCES } from "../src/server.js";

// Smoke test for the Azure Functions custom-handler host: spawn the real HTTP
// server, then drive it with raw stateless streamable-HTTP JSON-RPC requests —
// the same shape the Functions host forwards. Proves the remote hosting entry
// point builds and serves the full tool surface without any Azure machinery.

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, "..", "functions", "server.js");

async function withHttpServer(fn) {
  const port = 3400 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    // Wait for the listen banner (or fail on early exit).
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start in time")), 10_000);
      proc.stdout.on("data", (d) => {
        if (String(d).includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      proc.on("exit", (code) => reject(new Error(`server exited early (${code})`)));
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    proc.kill();
  }
}

async function rpc(base, payload, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const raw = await res.text();
  const body = res.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(raw.split("\n").find((line) => line.startsWith("data: ")).slice(6))
    : JSON.parse(raw);
  return { status: res.status, body };
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "wire-test", version: "1.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function modernRpc(base, id, method, params = {}) {
  return rpc(
    base,
    { jsonrpc: "2.0", id, method, params: { ...params, _meta: MODERN_META } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method }
  );
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } },
};

test("Azure Functions streamable HTTP host", async (t) => {
  await t.test("initializes and lists the full tool surface", async () => {
    await withHttpServer(async (base) => {
      const init = await rpc(base, INIT);
      assert.equal(init.status, 200);
      assert.equal(init.body.result.serverInfo.name, "str-mcp-purview");

      const list = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      assert.equal(list.status, 200);
      const names = list.body.result.tools.map((tool) => tool.name);
      assert.ok(names.includes("list_sensitivity_labels"));
      assert.ok(names.includes("list_dlp_policies"));
      assert.ok(names.includes("list_label_policies"));
      assert.equal(names.length, 26);
      assert.deepEqual(init.body.result.capabilities, { tools: {}, prompts: {}, resources: {} });
      assert.deepEqual(list.body.result.tools, TOOLS);
      for (const tool of list.body.result.tools) {
        assert.ok(tool.annotations, `${tool.name} should carry annotations over HTTP too`);
      }
    });
  });

  await t.test("serves modern discovery and primitives without initialize or sessions", async () => {
    await withHttpServer(async (base) => {
      const discover = await modernRpc(base, "discover", "server/discover");
      assert.equal(discover.status, 200);
      assert.ok(
        discover.body.result.supportedVersions?.includes("2026-07-28"),
        JSON.stringify(discover.body)
      );
      assert.equal(discover.body.result.resultType, "complete");
      assert.equal(discover.body.result.ttlMs, 300_000);
      assert.equal(discover.body.result.cacheScope, "public");
      assert.equal(discover.body.result._meta["io.modelcontextprotocol/serverInfo"].name, "str-mcp-purview");

      const tools = await modernRpc(base, "tools", "tools/list");
      assert.equal(tools.status, 200);
      assert.deepEqual(tools.body.result.tools, TOOLS);
      assert.equal(tools.body.result.resultType, "complete");
      assert.equal(tools.body.result.ttlMs, 300_000);
      assert.equal(tools.body.result.cacheScope, "public");
      assert.equal(tools.body.result._meta["io.modelcontextprotocol/serverInfo"].name, "str-mcp-purview");

      const prompts = await modernRpc(base, "prompts", "prompts/list");
      assert.deepEqual(prompts.body.result.prompts, PROMPTS);
      const resources = await modernRpc(base, "resources", "resources/list");
      assert.deepEqual(resources.body.result.resources, RESOURCES);
      assert.equal(discover.body.result.protocolVersion, undefined);
    });
  });

  await t.test("rejects non-POST methods and unknown paths", async () => {
    await withHttpServer(async (base) => {
      const get = await fetch(`${base}/mcp`);
      assert.equal(get.status, 405);
      const wrong = await fetch(`${base}/nope`, { method: "POST" });
      assert.equal(wrong.status, 404);
      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200);

      const badOrigin = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify(INIT),
      });
      assert.equal(badOrigin.status, 403);

      const badType = await fetch(`${base}/mcp`, { method: "POST", body: JSON.stringify(INIT) });
      assert.equal(badType.status, 415);

      const malformed = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error.code, -32700);

      const mismatch = await rpc(
        base,
        { jsonrpc: "2.0", id: "mismatch", method: "tools/list", params: { _meta: MODERN_META } },
        { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "prompts/list" }
      );
      assert.equal(mismatch.status, 400);
      assert.equal(mismatch.body.error.code, -32020);
    });
  });
});
