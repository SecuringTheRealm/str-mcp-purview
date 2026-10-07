import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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

async function withClient(fn, mode = "full") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { PATH: process.env.PATH ?? "", PURVIEW_TOOL_MODE: mode },
  });
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

async function withModernClient(fn) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { PATH: process.env.PATH ?? "", PURVIEW_TOOL_MODE: "full" },
  });
  const client = new Client(
    { name: "modern-test-client", version: "1.0.0" },
    { capabilities: {}, versionNegotiation: { mode: { pin: "2026-07-28" } } }
  );
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

test("MCP server over stdio", async (t) => {
  for (const mode of ["compact", "dispatcher"]) {
    await t.test(`${mode} supports search and execution over stdio`, async () => {
      await withClient(async (client) => {
        const { tools } = await client.listTools();
        assert.equal(tools.length, mode === "compact" ? 8 : 3);
        const found = await client.callTool({ name: mode === "compact" ? "purview_search" : "purview_search_capabilities", arguments: { query: "Check authentication status", limit: 1 } });
        const candidate = JSON.parse(found.content[0].text).items[0];
        assert.equal(candidate.capability_id, "get_auth_status");
        assert.equal(candidate.input_schema, undefined);
        const described = await client.callTool({ name: "purview_describe_capability", arguments: { capability_id: candidate.capability_id } });
        assert.equal(described.structuredContent.input_schema.type, "object");
        const { tool, ...route } = candidate.invocation;
        const result = await client.callTool({ name: tool, arguments: { ...route, arguments: {} } });
        assert.equal(JSON.parse(result.content[0].text).credentials_verified, false);
        assert.ok(!result.isError);
      }, mode);
    });
  }
  await t.test("negotiates modern 2026-07-28 through server/discover", async () => {
    await withModernClient(async (client) => {
      assert.equal(client.getProtocolEra(), "modern");
      assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
      const { tools } = await client.listTools();
      assert.equal(tools.length, 37);
    });
  });

  await t.test("lists all expected tools with schemas", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        "create_auto_label_policy",
        "create_auto_label_rule",
        "create_copilot_dlp_policy",
        "create_copilot_dlp_rule",
        "create_dlp_policy",
        "create_dlp_rule",
        "create_endpoint_dlp_policy",
        "create_endpoint_dlp_rule",
        "create_label_policy",
        "create_sensitivity_label",
        "get_auth_status",
        "get_auto_label_policy",
        "get_auto_label_rule",
        "get_dlp_policy",
        "get_dlp_rule",
        "get_label_policy",
        "get_label_policy_settings",
        "get_sensitivity_label",
        "list_dlp_policies",
        "list_auto_label_policies",
        "list_auto_label_rules",
        "list_dlp_rules",
        "list_label_policies",
        "list_sensitive_information_types",
        "list_sensitivity_labels",
        "remove_dlp_policy",
        "remove_auto_label_policy",
        "remove_auto_label_rule",
        "remove_dlp_rule",
        "remove_label_policy",
        "remove_sensitivity_label",
        "set_dlp_policy",
        "set_auto_label_policy",
        "set_auto_label_rule",
        "set_dlp_rule",
        "set_label_policy",
        "set_sensitivity_label",
      ].sort());
      for (const tool of tools) {
        assert.equal(typeof tool.description, "string");
        assert.ok(tool.description.length > 0, `${tool.name} should have a description`);
        assert.equal(tool.inputSchema.type, "object");
      }
      for (const name of [
        "list_sensitivity_labels",
        "list_label_policies",
        "list_dlp_policies",
        "list_dlp_rules",
        "list_sensitive_information_types",
      ]) {
        const tool = tools.find((candidate) => candidate.name === name);
        assert.deepEqual(tool.inputSchema.properties.limit, {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
        });
        assert.equal(tool.inputSchema.properties.cursor.type, "string");
        assert.deepEqual(tool.outputSchema.required, [
          "items",
          "count",
          "total_count",
          "has_more",
          "next_cursor",
        ]);
      }
      const ruleDetail = tools.find((tool) => tool.name === "get_dlp_rule");
      assert.equal(ruleDetail.inputSchema.properties.limit.default, 25);
      assert.equal(ruleDetail.inputSchema.properties.cursor.type, "string");
      assert.deepEqual(ruleDetail.outputSchema.required, [
        "items",
        "count",
        "total_count",
        "has_more",
        "next_cursor",
      ]);
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
        assert.equal(a.openWorldHint, tool.name !== "get_auth_status", `${tool.name} openWorldHint`);
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
      assert.deepEqual(byName.create_sensitivity_label.inputSchema.required, ["name", "display_name"]);
      assert.deepEqual(byName.create_sensitivity_label.inputSchema.else.required, ["tooltip"]);
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

  await t.test("exposes tuned SITs, rule controls, notifications, exceptions, and location exceptions", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
      for (const name of ["create_dlp_rule", "set_dlp_rule"]) {
        const props = byName[name].inputSchema.properties;
        assert.equal(props.sensitive_information_types.items.oneOf[0].type, "string");
        assert.deepEqual(
          props.sensitive_information_types.items.oneOf[1].properties.confidence_level.enum,
          ["Low", "Medium", "High"]
        );
        assert.deepEqual(props.access_scope.enum, ["InOrganization", "NotInOrganization", "None"]);
        assert.deepEqual(props.report_severity_level.enum, ["None", "Low", "Medium", "High"]);
        assert.equal(props.notification_email_body.maxLength, 5000);
        assert.equal(props.policy_tip_text.maxLength, 256);
        assert.ok(props.exceptions.properties.sender_domain_is);
        assert.ok(props.exceptions.properties.sensitive_information_types);
      }
      assert.ok(byName.create_dlp_policy.inputSchema.properties.location_exceptions);
      assert.ok(byName.set_dlp_policy.inputSchema.properties.add_location_exceptions);
      assert.ok(byName.set_dlp_policy.inputSchema.properties.remove_location_exceptions);
      assert.ok(byName.create_endpoint_dlp_policy.inputSchema.properties.endpoint_location_exception);
    });
  });

  await t.test("rejects unsupported DLP access scope before calling PowerShell", async () => {
    await withClient(async (client) => {
      const result = await client.callTool({
        name: "create_dlp_rule",
        arguments: { name: "r1", policy: "p1", access_scope: "External" },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Invalid arguments/);
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
      assert.match(result.content[0].text, /required property 'identity'.*required property 'policy'/);
    });
  });

  await t.test("reports an unknown tool name as a protocol error", async () => {
    await withClient(async (client) => {
      await assert.rejects(
        () => client.callTool({ name: "not_a_real_tool", arguments: {} }),
        /Unknown tool: not_a_real_tool/
      );
    });
  });

  await t.test("deletion cannot proceed without form elicitation support", async () => {
    await withClient(async (client) => {
      for (const name of ["remove_dlp_policy", "remove_dlp_rule", "remove_sensitivity_label", "remove_label_policy"]) {
        for (const confirm of [undefined, false, true]) {
          const arguments_ = { identity: "do-not-delete" };
          if (confirm !== undefined) arguments_.confirm = confirm;
          const result = await client.callTool({ name, arguments: arguments_ });
          assert.equal(result.isError, true, `${name} should reject confirm=${confirm}`);
          assert.match(result.content[0].text, confirm === false ? /Invalid arguments/ : /form elicitation support/);
        }
      }
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
      // With no tenant authentication configured, list_sensitivity_labels must
      // fail gracefully rather than killing the server process.
      const result = await client.callTool({ name: "list_sensitivity_labels", arguments: {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Error:/);
    });
  });
});
