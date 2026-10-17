/** New handlers return MCP-compatible structured data with a concise text summary.
 * Existing list handlers retain {items,count,total_count,has_more,next_cursor}.
 * Completion is immediate; async jobs require an explicit future contract.
 */
export function capabilityResult(data, summary) {
  return { content: [{ type: "text", text: summary }], structuredContent: data };
}
