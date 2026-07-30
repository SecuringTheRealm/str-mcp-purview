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
        "create_label_policy",
        "create_sensitivity_label",
        "get_dlp_policy",
        "get_dlp_rule",
        "get_label_policy",
        "get_label_policy_settings",
        "get_sensitivity_label",
        "list_dlp_policies",
        "list_dlp_rules",
        "list_label_policies",
        "list_sensitive_information_types",
        "list_sensitivity_labels",
        "remove_dlp_policy",
        "remove_dlp_rule",
        "remove_label_policy",
        "remove_sensitivity_label",
        "set_dlp_policy",
        "set_dlp_rule",
        "set_label_policy",
        "set_sensitivity_label",
      ]);
      for (const tool of tools) {
        assert.equal(typeof tool.description, "string");
        assert.ok(tool.description.length > 0, `${tool.name} should have a description`);
        assert.equal(tool.inputSchema.type, "object");
      }
    });
  });

  await t.test("every tool declares full MCP annotations consistent with its verb", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        const a = tool.annotations;
        assert.ok(a, `${tool.name} should have annotations`);
        assert.ok(a.title && a.title !== tool.name, `${tool.name} should have a meaningful title`);
        for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
          assert.equal(typeof a[hint], "boolean", `${tool.name} should declare ${hint}`);
        }
        const verb = tool.name.split("_")[0];
        assert.equal(a.readOnlyHint, verb === "list" || verb === "get", `${tool.name} readOnlyHint`);
        if (verb === "remove" || verb === "set") assert.equal(a.destructiveHint, true, `${tool.name} destructiveHint`);
        if (verb === "create") {
          assert.equal(a.destructiveHint, false, `${tool.name} destructiveHint`);
          assert.equal(a.idempotentHint, false, `${tool.name} idempotentHint`);
        }
        assert.equal(a.openWorldHint, true, `${tool.name} openWorldHint`);
      }
    });
  });

  await t.test("rejects endpoint restrictions that block without notifying users", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "create_endpoint_dlp_rule",
        arguments: {
          name: "r1",
          policy: "p1",
          endpoint_restrictions: [{ activity: "CopyPaste", action: "Block" }],
        },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /require notify_user/);
    });
  });

  await t.test("marks required arguments on tools that need them", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      assert.deepEqual(byName.get_sensitivity_label.inputSchema.required, ["label_id"]);
      assert.deepEqual(byName.get_label_policy.inputSchema.required, ["identity"]);
      assert.equal(byName.list_label_policies.inputSchema.required, undefined);
      assert.deepEqual(byName.get_dlp_policy.inputSchema.required, ["identity"]);
      assert.equal(byName.get_dlp_rule.inputSchema.required, undefined);
      assert.deepEqual(byName.create_dlp_policy.inputSchema.required, ["name"]);
      assert.deepEqual(byName.create_dlp_rule.inputSchema.required, ["name", "policy"]);
      assert.deepEqual(byName.create_copilot_dlp_policy.inputSchema.required, ["name"]);
      assert.deepEqual(byName.create_copilot_dlp_rule.inputSchema.required, ["name", "policy"]);
      assert.deepEqual(byName.create_endpoint_dlp_policy.inputSchema.required, ["name"]);
      assert.deepEqual(byName.create_endpoint_dlp_rule.inputSchema.required, ["name", "policy", "endpoint_restrictions"]);
      assert.deepEqual(byName.create_sensitivity_label.inputSchema.required, ["name", "display_name", "tooltip"]);
      assert.deepEqual(byName.set_sensitivity_label.inputSchema.required, ["identity"]);
      assert.deepEqual(byName.create_label_policy.inputSchema.required, ["name", "labels"]);
      assert.deepEqual(byName.set_label_policy.inputSchema.required, ["identity"]);
      assert.deepEqual(byName.remove_dlp_policy.inputSchema.required, ["identity"]);
      assert.deepEqual(byName.remove_dlp_rule.inputSchema.required, ["identity"]);
      assert.deepEqual(byName.remove_sensitivity_label.inputSchema.required, ["identity"]);
      assert.deepEqual(byName.remove_label_policy.inputSchema.required, ["identity"]);
      assert.deepEqual(byName.set_dlp_policy.inputSchema.required, ["identity"]);
      assert.deepEqual(byName.set_dlp_rule.inputSchema.required, ["identity"]);
      assert.equal(byName.list_dlp_rules.inputSchema.required, undefined);
    });
  });

  await t.test("lists the analysis prompts", async () => {
    await withClient(async (client) => {
      const { prompts } = await client.listPrompts();
      const names = prompts.map((p) => p.name).sort();
      assert.deepEqual(names, ["data-security-posture", "dlp-control-review"]);
    });
  });

  await t.test("data-security-posture weaves in provided business_context and the chain steps", async () => {
    await withClient(async (client) => {
      const result = await client.getPrompt({
        name: "data-security-posture",
        arguments: { business_context: "EU fintech, PCI-DSS + GDPR" },
      });
      const body = result.messages[0].content.text;
      assert.match(body, /EU fintech, PCI-DSS \+ GDPR/);
      assert.match(body, /DEFINE .* REFERENCE .* ENFORCE .* COVER/);
      assert.match(body, /do NOT enumerate all built-in SITs/i);
      assert.match(body, /\[inferred . confirm\]/);
    });
  });

  await t.test("dlp-control-review encodes the effectiveness/hygiene contract and stalled-test proxy", async () => {
    await withClient(async (client) => {
      const result = await client.getPrompt({ name: "dlp-control-review", arguments: {} });
      const body = result.messages[0].content.text;
      assert.match(body, /list_dlp_rules/);
      assert.match(body, /Effectiveness/);
      assert.match(body, /Hygiene/);
      assert.match(body, /do NOT assign risk severities/i);
      assert.match(body, /WhenCreated/);
    });
  });

  await t.test("dlp-control-review scopes to a single policy when given", async () => {
    await withClient(async (client) => {
      const result = await client.getPrompt({ name: "dlp-control-review", arguments: { policy: "PII Policy" } });
      assert.match(result.messages[0].content.text, /review only the DLP policy "PII Policy"/);
    });
  });

  await t.test("get_dlp_rule with neither identity nor policy is a scoped error", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({ name: "get_dlp_rule", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /either 'identity'.*or 'policy'/);
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
