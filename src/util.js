import { createHash } from "node:crypto";

/**
 * PowerShell's ConvertTo-Json returns a single object when a cmdlet emits one
 * result and an array when it emits several. Normalise to an array.
 */
export const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

/** The value with object keys sorted at every depth, so equal data serialises equally. */
export const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
      : value;

export const canonicalJson = (value) => JSON.stringify(canonical(value));

/** SHA-256 of the canonical JSON form. */
export const digest = (value, encoding = "hex") => createHash("sha256").update(canonicalJson(value)).digest(encoding);

/** Purview's named SIT confidence levels as minimum-confidence percentages. */
export const CONFIDENCE = { Low: 65, Medium: 75, High: 85 };
