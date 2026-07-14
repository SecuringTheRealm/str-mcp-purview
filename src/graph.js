// Microsoft Graph access for the delegated (signed-in admin) scenario.
//
// We deliberately avoid the typed Graph SDK: the Purview Information
// Protection endpoints we need live under /beta and are not fully modelled by
// the SDK. A raw fetch against the beta endpoint with a bearer token from
// @azure/identity is cleaner and mirrors the raw-fetch idiom of nvd-mcp-local.

import { getToken, appOnly } from "./auth.js";

// Re-exported so labels.js can pick the tenant-wide path in app-only mode.
export { appOnly };

const GRAPH_BETA = "https://graph.microsoft.com/beta";

// Scopes required for the sensitivity-label read tools. Delegated permission
// InformationProtectionPolicy.Read is the least-privileged option per the
// Graph reference for the sensitivityLabel resource. In app-only mode the
// token must be requested for .default (the app's granted application
// permissions, i.e. InformationProtectionPolicy.Read.All).
const LABEL_SCOPES = ["https://graph.microsoft.com/InformationProtectionPolicy.Read"];
const APP_SCOPES = ["https://graph.microsoft.com/.default"];

const bearer = () => getToken(appOnly ? APP_SCOPES : LABEL_SCOPES);

/**
 * GET a Graph beta path as the signed-in admin.
 * @param {string} path  Path beginning with "/", e.g. "/me/security/informationProtection/sensitivityLabels".
 * @param {object} [params]  Query string parameters (OData $select, $filter, ...).
 */
export async function graphGet(path, params = {}) {
  const url = new URL(path.startsWith("https://") ? path : `${GRAPH_BETA}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${await bearer()}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Graph ${res.status} ${res.statusText}${detail ? `: ${truncateError(detail)}` : ""}`);
  }
  return res.json();
}

/**
 * GET a Graph collection, following @odata.nextLink so large tenants are not
 * silently truncated to the first page.
 */
export async function graphGetAll(path, params = {}) {
  const items = [];
  let data = await graphGet(path, params);
  for (;;) {
    items.push(...(data.value ?? []));
    if (!data["@odata.nextLink"]) return items;
    data = await graphGet(data["@odata.nextLink"]);
  }
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
