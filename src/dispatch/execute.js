import Ajv from "ajv";
import { capabilityById } from "../capabilities/registry.js";
import { permitted } from "../retrieval/filters.js";
import { CapabilityError } from "./errors.js";
import { envInt } from "../util.js";

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
const validators = new WeakMap();
export function validateArguments(schema, args, name) {
  let validate = validators.get(schema);
  if (!validate) { validate = ajv.compile(schema); validators.set(schema, validate); }
  if (!validate(args)) {
    throw new CapabilityError("VALIDATION_ERROR", `Invalid arguments for ${name}: ${validate.errors.map((e) => `${e.instancePath || "arguments"} ${e.message}`).join("; ")}.${schema.description ? ` ${schema.description}` : ""} Correct the arguments and retry.`);
  }
}

// Writes run one at a time. Several read the current object and then set it,
// so two interleaved writes could silently drop one change. The lock covers
// only the handler, so a pending deletion form does not hold up other writes.
// Waiting writes are bounded like the PowerShell queue, and a write whose
// caller has gone away is dropped before it starts.
let writeQueue = Promise.resolve();
let waitingWrites = 0;
function serialised(fn, signal) {
  if (waitingWrites > envInt("PURVIEW_MAX_QUEUED_COMMANDS", Infinity)) {
    throw new CapabilityError("BUSY", `${waitingWrites} writes are already waiting. Nothing was sent; retry in a few seconds.`);
  }
  waitingWrites += 1;
  const run = writeQueue.then(() => {
    waitingWrites -= 1;
    if (signal?.aborted) throw new CapabilityError("CANCELLED", "The request was cancelled before the write started. Nothing was sent.");
    return fn();
  });
  writeQueue = run.catch(() => {});
  return run;
}

export async function executeCapability(id, args = {}, policy = {}, registry = capabilityById, authorize, interaction = {}) {
  const capability = registry.get(id);
  if (!capability || !permitted(capability, policy)) throw new CapabilityError("CAPABILITY_UNAVAILABLE", "Capability unavailable or not permitted.");
  const input = structuredClone(args);
  validateArguments(capability.inputSchema, input, capability.id);
  const checkAuthorization = async () => {
    if (!authorize) return;
    let allowed = false;
    try {
      allowed = await authorize({ capability: { id: capability.id, domain: capability.domain, operation: capability.operation, action: capability.action, risk: capability.risk }, arguments: structuredClone(input) });
    } catch { /* Fail closed, without disclosing policy internals. */ }
    if (allowed !== true) throw new CapabilityError("POLICY_DENIED", "Request denied by resource or argument policy.");
  };
  await checkAuthorization();
  if (capability.deletes) {
    if (!interaction.confirmDeletion) throw new CapabilityError("CONFIRMATION_REQUIRED", "Deletion requires form elicitation confirmation; confirm:true alone is insufficient.");
    const review = await interaction.confirmDeletion(capability, input, interaction.context);
    if (review.result) return review.result;
    input.identity = review.identity;
    validateArguments(capability.inputSchema, input, capability.id);
    await checkAuthorization();
  }
  try {
    return await (capability.action === "write"
      ? serialised(() => capability.handler(input), interaction.context?.mcpReq?.signal)
      : capability.handler(input));
  } catch (error) {
    if (error instanceof CapabilityError) throw error;
    // BUSY: refused before anything was sent, so retrying is safe.
    // OUTCOME_UNCERTAIN: a write may have applied; read before retrying.
    throw new CapabilityError(error.busy || error.notStarted ? "BUSY" : error.uncertain ? "OUTCOME_UNCERTAIN" : "BACKEND_ERROR", error.message);
  }
}
