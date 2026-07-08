// Shared token-efficient formatting helpers.
//
// The design goal, borrowed from the nvd-mcp-local server, is that tool
// responses must stay lean so they do not consume large portions of the
// model's context window. List tools return one compact line per record;
// detail tools return structured markdown. We never dump raw JSON.

/** Truncate a string to `max` characters, appending an ellipsis if cut. */
export function truncate(value, max = 100) {
  if (value == null) return "";
  const s = String(value);
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

/** Coerce a possibly-missing value to a printable cell, padded to `width`. */
export function cell(value, width) {
  const s = value == null || value === "" ? "-" : String(value);
  return width ? s.padEnd(width) : s;
}

/** Format an ISO date-time down to just the date portion. */
export function shortDate(value) {
  if (!value) return "-";
  return String(value).slice(0, 10);
}

/** Render a flat object as a markdown bullet list of key: value pairs. */
export function bulletFields(obj, fields) {
  const lines = [];
  for (const [key, label] of fields) {
    const v = obj?.[key];
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(`- **${label}:** ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  return lines.join("\n");
}

/**
 * PowerShell's ConvertTo-Json returns a single object when a cmdlet emits one
 * result and an array when it emits several. Normalise to an array so callers
 * can always iterate.
 */
export function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Render the result of a write cmdlet (New-/Set-*) as a compact confirmation.
 * Shared by the DLP and label write tools — the whitelisted fields degrade
 * gracefully when a given object doesn't carry them.
 */
export function formatWriteResult(verb, obj) {
  const item = asArray(obj)[0] ?? obj;
  if (!item) return `${verb} completed.`;
  const id = item.Name ?? item.DisplayName ?? item.Identity ?? item.Guid ?? "(unknown)";
  return `${verb} succeeded: ${id}\n${bulletFields(item, [
    ["Guid", "GUID"],
    ["DisplayName", "Display name"],
    ["ParentId", "Parent"],
    ["Policy", "Policy"],
    ["ParentPolicyName", "Policy"],
    ["Mode", "Mode"],
    ["Enabled", "Enabled"],
    ["Disabled", "Disabled"],
    ["Priority", "Priority"],
    ["BlockAccess", "Block access"],
  ])}`;
}
