import { createHash } from "node:crypto";

/**
 * PowerShell's ConvertTo-Json returns a single object when a cmdlet emits one
 * result and an array when it emits several. Normalise to an array.
 */
export const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);

/** Case- and whitespace-insensitive key for matching names, GUIDs and identities. */
export const identityKey = (value) => String(value ?? "").trim().toLowerCase();

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

/** One of `allowed` (case-insensitive) or `fallback` when unset; anything else throws. */
export function envChoice(name, allowed, fallback, env = process.env) {
  const raw = String(env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (allowed.includes(raw)) return raw;
  throw new Error(`${name} must be one of ${allowed.join(", ")} (got "${env[name]}").`);
}

/**
 * A boolean environment flag: true/false, 1/0 or yes/no in any case; unset
 * gives `fallback`. Anything else throws, so a typo in a safety switch stops
 * the server instead of being read as "off".
 */
export function envFlag(name, fallback, env = process.env) {
  const value = envChoice(name, ["true", "1", "yes", "false", "0", "no"], null, env);
  return value === null ? fallback : ["true", "1", "yes"].includes(value);
}

/** A positive integer setting, or `fallback` when unset; anything else throws. */
export function envInt(name, fallback, env = process.env) {
  const raw = String(env[name] ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer (got "${env[name]}").`);
  return value;
}

// Security & Compliance PowerShell settings, shared by the bridge and get_auth_status.
/** Whether Connect-IPPSSession can run here (Windows, unless overridden). */
export const platformSupported = (env = process.env) => process.platform === "win32" || env.PURVIEW_ALLOW_UNSUPPORTED_OS === "1";

/** How the bridge connects: certificate app-only when all three settings are present, else token injection or interactive. */
export function dlpAuthMode(env = process.env) {
  if (env.PURVIEW_APP_ID && env.PURVIEW_ORGANIZATION && env.PURVIEW_CERT_THUMBPRINT) return "certificate";
  return envChoice("PURVIEW_DLP_AUTH_MODE", ["token", "interactive"], "token", env);
}
