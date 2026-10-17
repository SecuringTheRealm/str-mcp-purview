import { randomBytes } from "node:crypto";
import { digest } from "../util.js";
import { inputRequired } from "@modelcontextprotocol/server";
import * as labels from "../labels.js";
import * as dlp from "../dlp.js";
import * as autoLabels from "../auto-labels.js";
import { CapabilityError } from "../dispatch/errors.js";

const KEY = "confirm_deletion";
const pending = new Map();
const TTL_MS = 5 * 60_000;

const fail = (message) => { throw new CapabilityError("CONFIRMATION_REQUIRED", message); };

// Per delete capability: how to read the target (and its rules, if deleting it
// takes them too) and what the confirmation form says will happen.
const TARGETS = {
  remove_sensitivity_label: { read: (id) => labels.getLabel(id), consequence: () => "Deletes this sensitivity label; review dependent publishing policies first." },
  remove_label_policy: { read: (id) => labels.getLabelPolicy(id), consequence: () => "Unpublishes this policy's labels from its users." },
  remove_dlp_policy: {
    read: (id) => dlp.getPolicy(id), rules: (guid) => dlp.listRules(guid, { detail: true }),
    consequence: (rules) => `Deletes this DLP policy and its ${rules.length} rule(s).`,
  },
  remove_dlp_rule: { read: (id) => dlp.getRule(id), consequence: () => "Deletes this DLP rule and removes the protection it provides." },
  remove_auto_label_policy: {
    read: (id) => autoLabels.getPolicy(id), rules: (guid) => autoLabels.listRules(guid),
    consequence: (rules) => `Deletes this auto-label policy with ${rules.length} associated rule(s). Labels already applied to content are not reversed.`,
  },
  remove_auto_label_rule: { read: (id) => autoLabels.getRule(id), consequence: () => "Deletes this automatic labeling rule. Labels already applied to content are not reversed." },
};

async function resolveTarget(capability, args) {
  const target = TARGETS[capability.id];
  if (!target) fail("No deletion review resolver is registered for this capability.");
  const object = await target.read(args.identity);
  if (typeof object?.Guid !== "string" || !object.Guid.trim()) fail("Cannot resolve a stable GUID for the deletion target. Nothing was deleted.");
  const rules = target.rules ? await target.rules(object.Guid) : undefined;
  return {
    identity: object.Guid,
    name: object.DisplayName ?? object.Name ?? object.Guid,
    fingerprint: digest({ object, rules }),
    consequence: target.consequence(rules),
  };
}

/** Opaque random handles reference server-owned state; no client-supplied approval token is trusted. */
export function createDeletionConfirmation({
  principal, client, tenant = process.env.AZURE_TENANT_ID ?? process.env.PURVIEW_ORGANIZATION,
  resolve = resolveTarget, store = pending, now = Date.now,
} = {}) {
  return async (capability, args, context) => {
    // Caller identity first: over HTTP it is the usual reason, and the fix is server-side.
    if (typeof principal !== "string" || !principal || typeof client !== "string" || !client) {
      fail("Deletion requires a trusted caller and client identity; over HTTP, set MCP_TRUST_EASY_AUTH behind App Service Authentication. Nothing was deleted.");
    }
    const elicitation = context?.clientCapabilities?.elicitation;
    if (!elicitation || (elicitation.form === undefined && Object.keys(elicitation).length !== 0)) {
      fail("Deletion requires a client with form elicitation support (MCP 2026-07-28 over HTTP). Nothing was deleted.");
    }
    if (!tenant) fail("Deletion requires AZURE_TENANT_ID or PURVIEW_ORGANIZATION, so the form can name the tenant. Nothing was deleted.");
    if (context.mcpReq?.signal?.aborted) fail("Deletion was cancelled. Nothing was deleted.");
    const binding = digest({ principal, client, tenant, capability: capability.id, args });
    // Any per-request envelope means the modern (2026-07-28 or later) era with MRTR.
    const modern = Boolean(context.mcpReq?.envelope?.["io.modelcontextprotocol/protocolVersion"]);
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
