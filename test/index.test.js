import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// index.js connects its stdio transport at import time, so it is spawned as a
// real child process rather than imported. One server is reused per protocol
// era to keep the spawn count (and runtime) down. No credentials are
// configured, so every call below fails fast and deterministically.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "index.js");

async function connect(options = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { PATH: process.env.PATH ?? "", PURVIEW_TOOL_MODE: "full" },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {}, ...options });
  await client.connect(transport);
  return client;
}

async function assertAuthStatus(client) {
  const result = await client.callTool({ name: "get_auth_status", arguments: {} });
  assert.ok(!result.isError);
  assert.equal(JSON.parse(result.content[0].text).credentials_verified, false);
}

describe("2025 initialize era over stdio", () => {
  let client;
  before(async () => {
    client = await connect();
  });
  after(() => client?.close());

  test("lists tools and runs get_auth_status", async () => {
    assert.equal(client.getProtocolEra(), "legacy");
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "get_auth_status"));
    await assertAuthStatus(client);
  });

  test("reports an unknown tool as a protocol error", async () => {
    await assert.rejects(() => client.callTool({ name: "not_a_real_tool", arguments: {} }), /Unknown tool: not_a_real_tool/);
  });

  test("deletion fails closed without form elicitation support", async () => {
    for (const confirm of [undefined, true]) {
      const result = await client.callTool({
        name: "remove_dlp_policy",
        arguments: { identity: "do-not-delete", ...(confirm && { confirm }) },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /form elicitation support/);
    }
  });
});

test("2026-07-28 era negotiates via server/discover and serves calls", async () => {
  const client = await connect({ versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "get_auth_status"));
    await assertAuthStatus(client);
  } finally {
    await client.close();
  }
});
