import { authMode } from "../auth.js";

// Configuration diagnostics only: never mint tokens or initiate authentication.
export function authStatus() {
  const e = process.env;
  const certificateApp = Boolean(e.PURVIEW_APP_ID && e.PURVIEW_ORGANIZATION && e.PURVIEW_CERT_THUMBPRINT);
  const missing = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID"].filter((name) => authMode !== "managedidentity" && !e[name]);
  const result = {
    mode: authMode,
    graph_configured: missing.length === 0,
    powershell_auth: certificateApp ? "certificate" : "token",
    powershell_platform_supported: process.platform === "win32" || e.PURVIEW_ALLOW_UNSUPPORTED_OS === "1",
    missing,
    credentials_verified: false,
    note: "Configuration only. PowerShell availability, credentials, consent and tenant RBAC are checked by actual backend calls.",
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}
