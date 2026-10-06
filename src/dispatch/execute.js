import Ajv from "ajv";
import { capabilityById } from "../capabilities/registry.js";
import { permitted } from "../retrieval/filters.js";
import { CapabilityError } from "./errors.js";

const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
const validators = new WeakMap();
export function validateArguments(schema, args, name) {
  let validate = validators.get(schema);
  if (!validate) { validate = ajv.compile(schema); validators.set(schema, validate); }
  if (!validate(args)) {
    throw new CapabilityError("VALIDATION_ERROR", `Invalid arguments for ${name}: ${validate.errors.map((e) => `${e.instancePath || "arguments"} ${e.message}`).join("; ")}.${schema.description ? ` ${schema.description}` : ""} Correct the arguments and retry.`);
  }
}

export async function executeCapability(id, args = {}, policy = {}, registry = capabilityById, authorize) {
  const capability = registry.get(id);
  if (!capability || !permitted(capability, policy)) throw new CapabilityError("CAPABILITY_UNAVAILABLE", "Capability unavailable or not permitted.");
  const input = structuredClone(args);
  validateArguments(capability.inputSchema, input, capability.id);
  if (authorize) {
    let allowed = false;
    try {
      allowed = await authorize({ capability: { id: capability.id, domain: capability.domain, operation: capability.operation, action: capability.action, risk: capability.risk }, arguments: structuredClone(input) });
    } catch { /* Fail closed, without disclosing policy internals. */ }
    if (allowed !== true) throw new CapabilityError("POLICY_DENIED", "Request denied by resource or argument policy.");
  }
  try { return await capability.handler(input); }
  catch (error) {
    if (error instanceof CapabilityError) throw error;
    throw new CapabilityError("BACKEND_ERROR", error.message);
  }
}
