export class CapabilityError extends Error {
  constructor(code, message) { super(message); this.name = "CapabilityError"; this.code = code; }
}

/** The arguments are wrong and nothing was sent to Purview. */
export const invalid = (message) => { throw new CapabilityError("VALIDATION_ERROR", message); };

export function errorResult(error) {
  const detail = {
    code: error instanceof CapabilityError ? error.code : "INTERNAL_ERROR",
    message: error.message,
    // Only a request refused before anything was sent is safe to repeat as is.
    retryable: error.code === "BUSY",
  };
  return { isError: true, content: [{ type: "text", text: `Error: ${detail.message}` }], structuredContent: { error: detail } };
}
