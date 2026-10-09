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
