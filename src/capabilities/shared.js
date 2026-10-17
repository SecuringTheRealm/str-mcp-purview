import { createListPaginator } from "../pagination.js";
import { invalid } from "../dispatch/errors.js";
function text(t) {
  return { content: [{ type: "text", text: t }] };
}

const pageResult = createListPaginator();

// Per New-DlpComplianceRule, Block/Warn endpoint restrictions require NotifyUser;
// fail fast with a clear message instead of a cryptic server-side error.
function assertEndpointNotify(args) {
  const needsNotify = (args.endpoint_restrictions ?? []).some((r) => r.action === "Block" || r.action === "Warn");
  if (needsNotify && !args.notify_user?.length) {
    invalid("Endpoint restrictions with a Block or Warn action require notify_user.");
  }
}

// A Set- call whose arguments map to nothing would report success untouched.
function assertChanges(params) {
  if (Object.keys(params).length < 2) {
    invalid("No changes supplied; nothing was sent to Purview.");
  }
}

export { text, pageResult, assertEndpointNotify, assertChanges };

