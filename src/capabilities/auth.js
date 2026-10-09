// Configuration diagnostics only: never mint tokens or initiate authentication.
export function authStatus() {
  const e = process.env;
  const mode = (e.PURVIEW_AUTH_MODE || "interactive").toLowerCase();
  const result = {
    mode,
    graph_configured: mode === "managedidentity" || Boolean(e.AZURE_TENANT_ID && e.AZURE_CLIENT_ID),
    powershell_certificate_configured: Boolean(e.PURVIEW_APP_ID && e.PURVIEW_ORGANIZATION && e.PURVIEW_CERT_THUMBPRINT),
    credentials_verified: false,
    note: "Configuration only. PowerShell availability, credentials, consent and tenant RBAC are checked by actual backend calls.",
  };
  return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
}
