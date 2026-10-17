import { performance } from "node:perf_hooks";

const MAX_FIELD_LENGTH = 256;

function safeField(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return String(value).slice(0, MAX_FIELD_LENGTH);
}

/**
 * Wrap MCP request handlers with one redacted, structured completion record.
 * Tool arguments, results, tokens, and backend error messages are deliberately
 * excluded; stderr is protocol-safe for stdio and captured by Azure logging.
 */
export function createRequestLogger({
  transport = "unknown",
  era = "unknown",
  enabled = process.env.MCP_REQUEST_LOGGING !== "false",
  sink = (line) => console.error(line),
  clock = () => performance.now(),
  timestamp = () => new Date().toISOString(),
} = {}) {
  return function withRequestLogging(method, handler, requestFields = () => ({})) {
    return async (request, context) => {
      const started = clock();
      const envelope = context?.mcpReq?.envelope ?? {};
      const clientInfo = envelope["io.modelcontextprotocol/clientInfo"] ?? {};
      const extraFields = Object.fromEntries(
        Object.entries(requestFields(request))
          .map(([key, value]) => [key, safeField(value)])
          .filter(([, value]) => value !== undefined)
      );
      const base = {
        timestamp: timestamp(),
        event: "mcp.request.completed",
        transport,
        era,
        method,
        request_id: safeField(context?.mcpReq?.id),
        protocol_version: safeField(envelope["io.modelcontextprotocol/protocolVersion"]),
        client_name: safeField(clientInfo.name),
        client_version: safeField(clientInfo.version),
        traceparent: safeField(envelope.traceparent),
        authenticated_client_id: safeField(context?.http?.authInfo?.clientId),
        ...extraFields,
      };

      try {
        const result = await handler(request, context);
        if (enabled) {
          sink(JSON.stringify({
            ...base,
            level: result?.isError === true ? "warn" : "info",
            outcome: result?.isError === true ? "tool_error" : result?.resultType === "input_required" ? "input_required" : "success",
            duration_ms: Math.max(0, Math.round(clock() - started)),
          }));
        }
        return result;
      } catch (error) {
        if (enabled) {
          sink(JSON.stringify({
            ...base,
            level: "error",
            outcome: "protocol_error",
            error_type: safeField(error?.name ?? "Error"),
            duration_ms: Math.max(0, Math.round(clock() - started)),
          }));
        }
        throw error;
      }
    };
  };
}
