// Microsoft Graph access for the delegated (signed-in admin) scenario.
//
// We deliberately avoid the typed Graph SDK: the Purview Information
// Protection endpoints we need live under /beta and are not fully modelled by
// the SDK. A raw fetch against the beta endpoint with a bearer token from
// @azure/identity is cleaner and mirrors the raw-fetch idiom of nvd-mcp-local.

import { InteractiveBrowserCredential, DeviceCodeCredential } from "@azure/identity";

const GRAPH_BETA = "https://graph.microsoft.com/beta";

// Scopes required for the sensitivity-label read tools. Delegated permission
// InformationProtectionPolicy.Read is the least-privileged option per the
// Graph reference for the sensitivityLabel resource.
const LABEL_SCOPES = ["https://graph.microsoft.com/InformationProtectionPolicy.Read"];

let credential = null;

function getCredential() {
  if (credential) return credential;

  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new Error(
      "Graph auth is not configured. Set AZURE_TENANT_ID and AZURE_CLIENT_ID " +
        "to the tenant and a public-client app registration that has the " +
        "delegated InformationProtectionPolicy.Read permission granted."
    );
  }

  // PURVIEW_AUTH_MODE=devicecode is useful on headless boxes where no browser
  // can be launched; the default opens the system browser for interactive login.
  if ((process.env.PURVIEW_AUTH_MODE || "").toLowerCase() === "devicecode") {
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

async function bearer(scopes) {
  const token = await getCredential().getToken(scopes);
  if (!token?.token) throw new Error("Failed to acquire a Microsoft Graph access token.");
  return token.token;
}

/**
 * GET a Graph beta path as the signed-in admin.
 * @param {string} path  Path beginning with "/", e.g. "/me/security/informationProtection/sensitivityLabels".
 * @param {object} [params]  Query string parameters (OData $select, $filter, ...).
 */
export async function graphGet(path, params = {}) {
  const url = new URL(`${GRAPH_BETA}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${await bearer(LABEL_SCOPES)}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Graph ${res.status} ${res.statusText}${detail ? `: ${truncateError(detail)}` : ""}`);
  }
  return res.json();
}

function truncateError(text) {
  // Surface the Graph error message without dumping an entire HTML/JSON body.
  try {
    const j = JSON.parse(text);
    return j?.error?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
