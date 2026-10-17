import { performance } from "node:perf_hooks";
import { cases } from "./cases.js";
import { createProjection, searchCapabilities, searchLimit } from "../src/mcp/projection.js";

const limit = searchLimit();
const results = cases.map((item) => {
  const started = performance.now();
  const ranked = searchCapabilities(item.query, { limit });
  const latency_ms = performance.now() - started;
  const ids = ranked.map((c) => c.capability_id);
  const position = ids.indexOf(item.expected);
  const eager = searchCapabilities(item.query, { limit, includeSchemas: true });
  return { ...item, top_n: ids, hit: position >= 0, rank: position < 0 ? null : position + 1, latency_ms,
    candidate_bytes: Buffer.byteLength(JSON.stringify(ranked)),
    eager_candidate_bytes: Buffer.byteLength(JSON.stringify(eager)) };
});
const surface = Object.fromEntries(["full", "compact", "dispatcher"].map((mode) => {
  const tools = createProjection({ mode }).tools;
  return [mode, { tools: tools.length, schema_bytes: Buffer.byteLength(JSON.stringify(tools)) }];
}));
console.log(JSON.stringify({ limit, hits: results.filter((r) => r.hit).length, total: results.length, surface, results }, null, 2));
if (results.some((r) => !r.hit)) process.exitCode = 1;
