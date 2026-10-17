import { createHash, randomBytes } from "node:crypto";
import { inputRequired } from "@modelcontextprotocol/server";
import * as labels from "../labels.js";
import * as dlp from "../dlp.js";
import * as autoLabels from "../auto-labels.js";
import { CapabilityError } from "../dispatch/errors.js";

const KEY = "confirm_deletion";
const pending = new Map();
const TTL_MS = 5 * 60_000;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const digest = (value) => createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const fail = (message) => { throw new CapabilityError("CONFIRMATION_REQUIRED", message); };

async function resolveTarget(capability, args) {
  let object, rules;
  switch (capability.id) {
    case "remove_sensitivity_label": object = await labels.getLabel(args.identity); break;
    case "remove_label_policy": object = await labels.getLabelPolicy(args.identity); break;
    case "remove_dlp_policy":
      object = await dlp.getPolicy(args.identity);
      if (object?.Guid) rules = await dlp.listRules(object.Guid, { detail: true });
      break;
    case "remove_dlp_rule": object = await dlp.getRule(args.identity); break;
    case "remove_auto_label_policy":
      object = await autoLabels.getPolicy(args.identity);
      rules = await autoLabels.listRules(object.Guid);
      break;
    case "remove_auto_label_rule": object = await autoLabels.getRule(args.identity); break;
    default: fail("No deletion review resolver is registered for this capability.");
  }
  if (typeof object?.Guid !== "string" || !object.Guid.trim()) fail("Cannot resolve a stable GUID for the deletion target. Nothing was deleted.");
  return {
    identity: object.Guid,
    name: object.DisplayName ?? object.Name ?? object.Guid,
    fingerprint: digest({ object, rules }),
    consequence: capability.id === "remove_auto_label_policy" ? `Deletes this auto-label policy with ${rules.length} associated rule(s). Labels already applied to content are not reversed.`
      : capability.id === "remove_auto_label_rule" ? "Deletes this automatic labeling rule. Labels already applied to content are not reversed."
      : capability.id === "remove_dlp_policy" ? `Deletes this DLP policy and its ${rules.length} rule(s).`
      : capability.id === "remove_label_policy" ? "Unpublishes this policy's labels from its users."
        : capability.id === "remove_sensitivity_label" ? "Deletes this sensitivity label; review dependent publishing policies first."
          : "Deletes this DLP rule and removes the protection it provides.",
  };
}

/** Opaque random handles reference server-owned state; no client-supplied approval token is trusted. */
export function createDeletionConfirmation({
  principal, client, tenant = process.env.AZURE_TENANT_ID ?? process.env.PURVIEW_ORGANIZATION,
  resolve = resolveTarget, store = pending, now = Date.now,
} = {}) {
  return async (capability, args, context) => {
    const elicitation = context?.clientCapabilities?.elicitation;
    if (!elicitation || (elicitation.form === undefined && Object.keys(elicitation).length !== 0)) {
      fail("Deletion requires a client with form elicitation support. Nothing was deleted.");
    }
    if (typeof principal !== "string" || !principal || typeof client !== "string" || !client || !tenant) {
      fail("Deletion requires trusted caller and client identities and a configured tenant. Nothing was deleted.");
    }
    if (context.mcpReq?.signal?.aborted) fail("Deletion was cancelled. Nothing was deleted.");
    const binding = digest({ principal, client, tenant, capability: capability.id, args });
    const modern = context.mcpReq?.envelope?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28";
    const form = (target) => ({
      mode: "form",
      message: `Permanently delete ${JSON.stringify(target.name)} (${target.identity}) in tenant ${tenant}? ${target.consequence} This changes tenant configuration.`,
      requestedSchema: { type: "object", properties: { confirm: { type: "boolean", title: "Confirm permanent deletion", default: false } }, required: ["confirm"] },
    });
    const affirmative = (response) => response?.action === "accept" && response.content?.confirm === true;
    const cancelled = (response) => ({ result: { content: [{ type: "text", text: `Deletion ${response?.action === "decline" ? "declined" : "cancelled"}. Nothing was deleted.` }] } });

    if (!modern) {
      if (typeof context.mcpReq?.elicitInput !== "function") fail("This transport cannot collect deletion confirmation.");
      const target = await resolve(capability, args);
      const expires = now() + TTL_MS;
      const response = await context.mcpReq.elicitInput(form(target), { timeout: TTL_MS });
      if (!affirmative(response)) return cancelled(response);
      if (now() >= expires) fail("The deletion review expired. Start a new review.");
      const current = await resolve(capability, { ...args, identity: target.identity });
      if (current.identity !== target.identity || current.fingerprint !== target.fingerprint) fail("The target changed during review. Start a new deletion review.");
      if (context.mcpReq.signal?.aborted) fail("Deletion was cancelled. Nothing was deleted.");
      return { identity: target.identity };
    }

    for (const [key, record] of store) if (record.expires <= now()) store.delete(key);
    const state = context.mcpReq.requestState?.();
    if (state !== undefined) {
      const record = typeof state === "string" ? store.get(state) : undefined;
      if (!record || record.binding !== binding) fail("Invalid, expired, already consumed, or mismatched deletion review. Start a new review.");
      const response = context.mcpReq.inputResponses?.[KEY];
      if (!response) return { result: inputRequired({ inputRequests: { [KEY]: inputRequired.elicit(form(record.target)) }, requestState: state }) };
      // Claim before awaiting anything: concurrent retries cannot both execute.
      store.delete(state);
      if (!affirmative(response)) return cancelled(response);
      const current = await resolve(capability, { ...args, identity: record.target.identity });
      if (current.identity !== record.target.identity || current.fingerprint !== record.target.fingerprint) fail("The target changed during review. Start a new deletion review.");
      if (context.mcpReq.signal?.aborted) fail("Deletion was cancelled. Nothing was deleted.");
      return { identity: record.target.identity };
    }
    // Unsolicited inputResponses never authorize a deletion.
    if (store.size >= 1000) fail("Too many pending deletion reviews. Try again later.");
    const target = await resolve(capability, args);
    if (store.size >= 1000) fail("Too many pending deletion reviews. Try again later.");
    const handle = randomBytes(32).toString("base64url");
    store.set(handle, { binding, target, expires: now() + TTL_MS });
    return { result: inputRequired({ inputRequests: { [KEY]: inputRequired.elicit(form(target)) }, requestState: handle }) };
  };
}
