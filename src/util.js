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

/**
 * A boolean environment flag. Accepts true/false, 1/0, yes/no (any case); an
 * unset or empty value gives `fallback`. Anything else throws, so a typo in a
 * safety switch stops the server instead of being read as "off".
 */
export function envFlag(name, fallback, env = process.env) {
  const raw = String(env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (["true", "1", "yes"].includes(raw)) return true;
  if (["false", "0", "no"].includes(raw)) return false;
  throw new Error(`${name} must be true or false (got "${env[name]}").`);
}

/** One of `allowed` (case-insensitive) or `fallback` when unset; anything else throws. */
export function envChoice(name, allowed, fallback, env = process.env) {
  const raw = String(env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (allowed.includes(raw)) return raw;
  throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${env[name]}").`);
}
