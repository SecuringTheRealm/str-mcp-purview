import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

async function rpc(base, payload) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
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
      for (const tool of list.body.result.tools) {
        assert.ok(tool.annotations, `${tool.name} should carry annotations over HTTP too`);
      }
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
    });
  });
});
