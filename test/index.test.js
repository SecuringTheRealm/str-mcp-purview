import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// index.js wires up an MCP server over stdio and calls server.connect()
// immediately at import time, so it cannot be imported in-process without
// hanging the test runner. Instead we spawn it as a real child process and
// talk to it over the actual MCP stdio protocol via the SDK's client — an
// integration test that verifies tool/prompt registration and dispatch
// end-to-end without needing live Graph/PowerShell backends (every listed
// tool call below fails fast on missing auth/pwsh config, which is itself
// verifiable, expected behaviour for a server with no credentials configured).

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "index.js");

async function withClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { PATH: process.env.PATH ?? "" },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

test("MCP server over stdio", async (t) => {
  await t.test("lists all expected tools with schemas", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        "create_copilot_dlp_policy",
        "create_copilot_dlp_rule",
        "create_dlp_policy",
        "create_dlp_rule",
        "create_endpoint_dlp_policy",
        "create_endpoint_dlp_rule",
        "get_dlp_policy",
        "get_label_policy_settings",
        "get_sensitivity_label",
        "list_dlp_policies",
        "list_dlp_rules",
        "list_sensitive_information_types",
        "list_sensitivity_labels",
        "set_dlp_policy",
        "set_dlp_rule",
      ]);
      for (const tool of tools) {
        assert.equal(typeof tool.description, "string");
        assert.ok(tool.description.length > 0, `${tool.name} should have a description`);
        assert.equal(tool.inputSchema.type, "object");
      }
    });
  });

  await t.test("marks required arguments on tools that need them", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      assert.deepEqual(byName.get_sensitivity_label.inputSchema.required, ["label_id"]);
      assert.deepEqual(byName.get_dlp_policy.inputSchema.required, ["identity"]);
      assert.deepEqual(byName.create_dlp_policy.inputSchema.required, ["name"]);
      assert.deepEqual(byName.create_dlp_rule.inputSchema.required, ["name", "policy"]);
      assert.deepEqual(byName.create_copilot_dlp_policy.inputSchema.required, ["name"]);
      assert.deepEqual(byName.create_copilot_dlp_rule.inputSchema.required, ["name", "policy"]);
      assert.deepEqual(byName.create_endpoint_dlp_policy.inputSchema.required, ["name"]);
      assert.deepEqual(byName.create_endpoint_dlp_rule.inputSchema.required, ["name", "policy", "endpoint_restrictions"]);
      assert.deepEqual(byName.set_dlp_policy.inputSchema.required, ["identity"]);
      assert.deepEqual(byName.set_dlp_rule.inputSchema.required, ["identity"]);
      assert.equal(byName.list_dlp_rules.inputSchema.required, undefined);
    });
  });

  await t.test("lists the two review prompts", async () => {
    await withClient(async (client) => {
      const { prompts } = await client.listPrompts();
      const names = prompts.map((p) => p.name).sort();
      assert.deepEqual(names, ["dlp-policy-review", "label-coverage-audit"]);
    });
  });

  await t.test("returns the chained-tool-call prompt text for dlp-policy-review", async () => {
    await withClient(async (client) => {
      const result = await client.getPrompt({ name: "dlp-policy-review", arguments: {} });
      const message = result.messages[0];
      assert.equal(message.role, "user");
      assert.match(message.content.text, /list_dlp_policies/);
      assert.match(message.content.text, /list_dlp_rules/);
    });
  });

  await t.test("reports an unknown tool name as an error result, not a crash", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "not_a_real_tool", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Unknown tool: not_a_real_tool/);
    });
  });

  await t.test("rejects an unknown prompt name", async () => {
    await withClient(async (client) => {
      await assert.rejects(() => client.getPrompt({ name: "not-a-real-prompt", arguments: {} }));
    });
  });

  await t.test("lists the SIT catalog resources", async () => {
    await withClient(async (client) => {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri).sort();
      assert.deepEqual(uris, ["purview://label-catalog", "purview://sit-catalog", "purview://sit-catalog/custom"]);
      for (const resource of resources) {
        assert.equal(resource.mimeType, "text/markdown");
        assert.ok(resource.description.length > 0);
      }
    });
  });

  await t.test("rejects an unknown resource URI", async () => {
    await withClient(async (client) => {
      await assert.rejects(() => client.readResource({ uri: "purview://not-a-real-resource" }));
    });
  });

  await t.test("surfaces backend configuration errors as tool-call errors, not crashes", async () => {
    await withClient(async (client) => {
      // With no AZURE_TENANT_ID/AZURE_CLIENT_ID configured, list_sensitivity_labels
      // must fail gracefully with an MCP error content block rather than
      // throwing an unhandled exception that kills the server process.
      const result = await client.callTool({ name: "list_sensitivity_labels", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Error:/);
    });
  });
});
