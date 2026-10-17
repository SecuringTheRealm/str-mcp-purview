import { resolveAuthMode } from "../auth.js";
import { dlpAuthMode, platformSupported } from "../util.js";
import { capabilityResult } from "./results.js";

// Configuration diagnostics only: never mint tokens or initiate authentication.
export function authStatus(_args, env = process.env) {
  const mode = resolveAuthMode(env);
  const missing = mode === "managedidentity" ? [] : ["AZURE_TENANT_ID", "AZURE_CLIENT_ID"].filter((name) => !env[name]);
  return capabilityResult({
    mode,
    graph_configured: missing.length === 0,
    powershell_auth: dlpAuthMode(env),
    powershell_platform_supported: platformSupported(env),
    missing,
    credentials_verified: false,
    note: "Configuration only. PowerShell availability, credentials, consent and tenant RBAC are checked by actual backend calls.",
  });
}
