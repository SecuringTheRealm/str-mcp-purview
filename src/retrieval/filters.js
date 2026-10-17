import { envFlag } from "../util.js";

const csv = (value) => value === undefined ? undefined : value.split(",").map((s) => s.trim()).filter(Boolean);

// Only server configuration or a trusted host may supply policy; never tool arguments.
export function policyFromEnvironment(env = process.env) {
  return {
    allowedIds: csv(env.PURVIEW_ALLOWED_CAPABILITIES),
    domains: csv(env.PURVIEW_ALLOWED_DOMAINS?.toLowerCase()),
    readOnly: envFlag("PURVIEW_READ_ONLY", false, env),
    allowDestructive: envFlag("PURVIEW_ALLOW_DESTRUCTIVE", true, env),
    scopes: csv(env.PURVIEW_SCOPES),
  };
}

export function permitted(c, policy = {}) {
  if (policy.allowedIds && !policy.allowedIds.includes(c.id)) return false;
  if (policy.domains && !policy.domains.includes(c.domain)) return false;
  if (policy.readOnly && c.action !== "read") return false;
  if (policy.allowDestructive === false && c.destructive) return false;
  if (policy.scopes && c.scopeAlternatives?.length && !c.scopeAlternatives.some((set) => set.every((s) => policy.scopes.includes(s)))) return false;
  return true;
}

export function filterCapabilities(entries, policy = {}, filters = {}) {
  return entries.filter((c) => permitted(c, policy)
    && (!filters.domain || c.domain === filters.domain)
    && (!filters.action || c.action === filters.action)
    && (filters.destructive === undefined || c.destructive === filters.destructive));
}
