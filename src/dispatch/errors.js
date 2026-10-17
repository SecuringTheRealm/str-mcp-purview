export class CapabilityError extends Error {
  constructor(code, message) { super(message); this.name = "CapabilityError"; this.code = code; }
}

export function errorResult(error) {
  const detail = {
    code: error instanceof CapabilityError ? error.code : "INTERNAL_ERROR",
    message: error.message,
    // Never automatically retry a mutation after an uncertain backend outcome.
    retryable: false,
  };
  return { isError: true, content: [{ type: "text", text: `Error: ${detail.message}` }], structuredContent: { error: detail } };
}
