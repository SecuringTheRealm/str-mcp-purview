import { createListPaginator } from "../pagination.js";
function text(t) {
  return { content: [{ type: "text", text: t }] };
}

const pageResult = createListPaginator();

// Per New-DlpComplianceRule, Block/Warn endpoint restrictions require NotifyUser;
// fail fast with a clear message instead of a cryptic server-side error.
function assertEndpointNotify(args) {
  const needsNotify = (args.endpoint_restrictions ?? []).some((r) => r.action === "Block" || r.action === "Warn");
  if (needsNotify && !args.notify_user?.length) {
    throw new Error("Endpoint restrictions with a Block or Warn action require notify_user.");
  }
}


export { text, pageResult, assertEndpointNotify };

