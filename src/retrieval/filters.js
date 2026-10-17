const csv = (value) => value === undefined ? undefined : value.split(",").map((s) => s.trim()).filter(Boolean);

// Only server configuration or a trusted host may supply policy; never tool arguments.
export function policyFromEnvironment(env = process.env) {
  return {
    allowedIds: csv(env.PURVIEW_ALLOWED_CAPABILITIES),
    domains: csv(env.PURVIEW_ALLOWED_DOMAINS),
    readOnly: env.PURVIEW_READ_ONLY === "true",
    allowDestructive: env.PURVIEW_ALLOW_DESTRUCTIVE !== "false",
    permissions: csv(env.PURVIEW_PERMISSIONS),
    scopes: csv(env.PURVIEW_SCOPES),
    features: csv(env.PURVIEW_FEATURES),
  };
}

export function permitted(c, policy = {}) {
  if (policy.allowedIds && !policy.allowedIds.includes(c.id)) return false;
  if (policy.domains && !policy.domains.includes(c.domain)) return false;
  if (policy.readOnly && c.action !== "read") return false;
  if (policy.allowDestructive === false && c.destructive) return false;
  if (policy.permissions && !(c.permissions ?? []).every((p) => policy.permissions.includes(p))) return false;
  if (policy.scopes && c.scopeAlternatives?.length && !c.scopeAlternatives.some((set) => set.every((s) => policy.scopes.includes(s)))) return false;
  if (c.features?.length && !c.features.every((f) => policy.features?.includes(f))) return false;
  return true;
}

export function filterCapabilities(entries, policy = {}, filters = {}) {
  return entries.filter((c) => permitted(c, policy)
    && (!filters.domain || c.domain === filters.domain)
    && (!filters.action || c.action === filters.action)
    && (filters.destructive === undefined || c.destructive === filters.destructive));
}
