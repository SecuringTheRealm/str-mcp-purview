// Shared Entra credential for both data planes.
//
// The Graph label tools and the Security & Compliance PowerShell bridge both
// need a bearer token, so the credential lives here and both planes import it.
// That means one sign-in, one token cache, and a single place that honours
// PURVIEW_AUTH_MODE.
//
// PURVIEW_AUTH_MODE selects the credential:
//   interactive (default)  browser sign-in as the operator — local use
//   devicecode             URL + code on stderr — headless boxes with a human
//   managedidentity        platform-minted token — hosted use, no secret at rest
// Setting AZURE_CLIENT_CERTIFICATE_PATH selects certificate app-only instead.

import {
  InteractiveBrowserCredential,
  DeviceCodeCredential,
  ClientCertificateCredential,
  ManagedIdentityCredential,
} from "@azure/identity";

const MODE = (process.env.PURVIEW_AUTH_MODE || "interactive").toLowerCase();
const CERT_PATH = process.env.AZURE_CLIENT_CERTIFICATE_PATH;

// App-only tokens carry no user context, so Graph's /me/ paths do not exist and
// label reads must use the tenant-wide path instead (see labels.js).
export const appOnly = MODE === "managedidentity" || Boolean(CERT_PATH);

let credential = null;

function getCredential() {
  if (credential) return credential;

  // Managed identity: the platform mints the token, so there is no certificate
  // or password at rest and nothing to rotate. Preferred for hosted deployments.
  if (MODE === "managedidentity") {
    const clientId = process.env.AZURE_CLIENT_ID;
    credential = new ManagedIdentityCredential(clientId ? { clientId } : {});
    return credential;
  }

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new Error(
      "Auth is not configured. Set AZURE_TENANT_ID and AZURE_CLIENT_ID to the " +
        "tenant and an app registration."
    );
  }

  if (CERT_PATH) {
    credential = new ClientCertificateCredential(tenantId, clientId, {
      certificatePath: CERT_PATH,
    });
    return credential;
  }

  if (MODE === "devicecode") {
    credential = new DeviceCodeCredential({
      tenantId,
      clientId,
      userPromptCallback: (info) => {
        // Device-code prompts must reach the operator without corrupting the
        // stdio JSON-RPC channel, so they go to stderr.
        process.stderr.write(`\n[purview] ${info.message}\n`);
      },
    });
  } else {
    credential = new InteractiveBrowserCredential({
      tenantId,
      clientId,
      redirectUri: process.env.AZURE_REDIRECT_URI || "http://localhost",
    });
  }
  return credential;
}

/**
 * Acquire an access token for the given scope(s) from the shared credential.
 * @param {string|string[]} scopes  e.g. "https://outlook.office365.com/.default"
 * @returns {Promise<string>} the raw bearer token
 */
export async function getToken(scopes) {
  const token = await getCredential().getToken(scopes);
  if (!token?.token) throw new Error("Failed to acquire an access token.");
  return token.token;
}
