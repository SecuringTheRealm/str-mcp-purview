import { test } from "node:test";
import assert from "node:assert/strict";

import { createRequestLogger } from "../src/request-logging.js";

function context() {
  return {
    mcpReq: {
      id: "request-1",
      envelope: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1" },
        traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      },
    },
  };
}

test("request logger emits redacted structured completion metadata", async () => {
  const lines = [];
  let clock = 10;
  const wrap = createRequestLogger({
    transport: "stdio",
    era: "modern",
    sink: (line) => lines.push(line),
    clock: () => (clock += 5),
    timestamp: () => "2026-09-22T00:00:00.000Z",
  });
  const handler = wrap("tools/call", async () => ({ content: [], isError: false }), (request) => ({
    tool: request.params.name,
  }));

  await handler(
    { params: { name: "list_dlp_rules", arguments: { secret: "must-not-be-logged" } } },
    context()
  );

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.equal(record.transport, "stdio");
  assert.equal(record.protocol_version, "2026-07-28");
  assert.equal(record.tool, "list_dlp_rules");
  assert.equal(record.outcome, "success");
  assert.equal(record.duration_ms, 5);
  assert.doesNotMatch(lines[0], /must-not-be-logged/);
});

test("request logger records error type without backend error details", async () => {
  const lines = [];
  const wrap = createRequestLogger({ sink: (line) => lines.push(line), clock: () => 1 });
  const handler = wrap("tools/call", async () => {
    throw new TypeError("tenant-sensitive backend response");
  });

  await assert.rejects(() => handler({ params: {} }, context()), /tenant-sensitive/);
  const record = JSON.parse(lines[0]);
  assert.equal(record.outcome, "protocol_error");
  assert.equal(record.error_type, "TypeError");
  assert.doesNotMatch(lines[0], /tenant-sensitive/);
});

test("logging follows MCP_REQUEST_LOGGING strictly and records the compact capability", async () => {
  const saved = process.env.MCP_REQUEST_LOGGING;
  try {
    process.env.MCP_REQUEST_LOGGING = "0";
    const quiet = [];
    await createRequestLogger({ sink: (l) => quiet.push(l) })("tools/call", async () => ({ content: [] }))({ params: {} }, context());
    assert.equal(quiet.length, 0);
    process.env.MCP_REQUEST_LOGGING = "maybe";
    assert.throws(() => createRequestLogger(), /MCP_REQUEST_LOGGING must be one of/);
  } finally {
    if (saved === undefined) delete process.env.MCP_REQUEST_LOGGING; else process.env.MCP_REQUEST_LOGGING = saved;
  }
  const lines = [];
  const wrap = createRequestLogger({ sink: (l) => lines.push(l) });
  await wrap("tools/call", async () => ({ content: [] }), (r) => ({ tool: r.params.name, capability: r.params.arguments?.operation }))(
    { params: { name: "purview_manage_dlp", arguments: { operation: "remove_dlp_rule" } } }, context());
  assert.equal(JSON.parse(lines[0]).capability, "remove_dlp_rule");
});

test("audit record carries the pseudonymous caller and the error code, never arguments", async () => {
  const lines = [];
  const wrap = createRequestLogger({ sink: (l) => lines.push(l), caller: { principal: "tenant-1/oid-1", client: "client-1" } });
  const failing = async () => ({ isError: true, structuredContent: { error: { code: "BUSY" } }, content: [] });
  await wrap("tools/call", failing, (r) => ({ tool: r.params.name }))({ params: { name: "set_dlp_rule", arguments: { identity: "Secret rule" } } }, context());
  const record = JSON.parse(lines[0]);
  assert.deepEqual([record.caller_principal, record.caller_client_id, record.error_code, record.outcome], ["tenant-1/oid-1", "client-1", "BUSY", "tool_error"]);
  assert.doesNotMatch(lines[0], /Secret rule/);
});

