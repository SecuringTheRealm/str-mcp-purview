import * as dlp from "../dlp.js";
import { text, pageResult, assertEndpointNotify } from "./shared.js";
import { oneDriveCreate, oneDriveUpdate, needsOneDriveRead, assertExchangeOnly, assertLocationExceptions } from "../dlp-validation.js";
import { CapabilityError } from "../dispatch/errors.js";

async function validateRulePolicy(args, updating = false) {
  if (!args.exceptions?.from?.length && !args.exceptions?.sent_to?.length) return;
  let policyId = args.policy;
  if (updating) {
    const rule = await dlp.getRule(args.identity);
    policyId = rule?.ParentPolicyName ?? rule?.Policy;
    if (policyId && typeof policyId === "object") policyId = policyId.Name ?? policyId.Identity;
  }
  if (typeof policyId !== "string" || !policyId) throw new CapabilityError("VALIDATION_ERROR", "Cannot resolve the rule's parent policy to verify Exchange-only exceptions.");
  assertExchangeOnly(await dlp.getPolicy(policyId));
}

export const handlers = {
  list_dlp_policies: async (args) => {
    const name = "list_dlp_policies";
    const items = dlp.filterPolicies(await dlp.listPolicies(), { mode: args.mode, workload: args.workload });
    return pageResult(name, args, items, dlp.formatPolicyList);
  },
  get_dlp_policy: async (args) => {
    return text(
      dlp.formatPolicyDetail(await dlp.getPolicy(args.identity, { distributionDetail: args.include_distribution_detail }))
    );
  },
  list_dlp_rules: async (args) => {
    const name = "list_dlp_rules";
    const items = dlp.filterRules(await dlp.listRules(args.policy), { disabledOnly: args.disabled_only, blockingOnly: args.blocking_only });
    return pageResult(name, args, items, dlp.formatRuleList);
  },
  get_dlp_rule: async (args) => {
    const name = "get_dlp_rule";
    if (args.identity) {
      const rule = await dlp.getRule(args.identity);
      return pageResult(
        name,
        args,
        rule ? [rule] : [],
        (page) => dlp.formatRuleDetail(page[0]),
        (item) => item
      );
    }
    if (args.policy) {
      return pageResult(
        name,
        args,
        await dlp.listRules(args.policy, { detail: true }),
        (page) => dlp.formatRuleDetails(page, args.policy),
        (item) => item
      );
    }
    throw new Error("get_dlp_rule requires either 'identity' (one rule) or 'policy' (all rules in a policy).");
  },
  create_dlp_policy: async (args) => {
    const params = { Name: args.name };
    if (args.mode) params.Mode = args.mode;
    if (args.comment) params.Comment = args.comment;
    if (args.exchange_location) params.ExchangeLocation = args.exchange_location;
    if (args.sharepoint_location) params.SharePointLocation = args.sharepoint_location;
    if (args.teams_location) params.TeamsLocation = args.teams_location;
    Object.assign(params, dlp.createPolicyLocationExceptionParams(args.location_exceptions));
    Object.assign(params, oneDriveCreate(args));
    assertLocationExceptions(params);
    return text(dlp.formatWriteResult("Create DLP policy", await dlp.createPolicy(params)));
  },
  set_dlp_policy: async (args) => {
    const params = { Identity: args.identity };
    if (args.mode) params.Mode = args.mode;
    if (args.comment) params.Comment = args.comment;
    const LOCATION_PARAMS = {
      exchange: "ExchangeLocation",
      sharepoint: "SharePointLocation",
      teams: "TeamsLocation",
      endpoint: "EndpointDlpLocation",
    };
    for (const [key, psName] of Object.entries(LOCATION_PARAMS)) {
      if (args.add_locations?.[key]?.length) params[`Add${psName}`] = args.add_locations[key];
      if (args.remove_locations?.[key]?.length) params[`Remove${psName}`] = args.remove_locations[key];
    }
    Object.assign(
      params,
      dlp.updatePolicyLocationExceptionParams(
        { ...args.add_location_exceptions, onedrive: undefined },
        { ...args.remove_location_exceptions, onedrive: undefined }
      )
    );
    const needsScope = needsOneDriveRead(args) || Object.values(args.add_location_exceptions ?? {}).some((v) => v?.length);
    const current = needsScope ? await dlp.getPolicy(args.identity) : undefined;
    Object.assign(params, oneDriveUpdate(args, current));
    assertLocationExceptions(params, current);
    return text(dlp.formatWriteResult("Set DLP policy", await dlp.setPolicy(params)));
  },
  create_dlp_rule: async (args) => {
    await validateRulePolicy(args);
    const params = { Name: args.name, Policy: args.policy, ...dlp.ruleWriteParams(args) };
    return text(dlp.formatWriteResult("Create DLP rule", await dlp.createRule(params)));
  },
  set_dlp_rule: async (args) => {
    assertEndpointNotify(args);
    const params = { Identity: args.identity, ...dlp.ruleWriteParams(args) };
    await validateRulePolicy(args, true);
    return text(dlp.formatWriteResult("Set DLP rule", await dlp.setRule(params)));
  },
  remove_dlp_policy: async (args) => {
    await dlp.removePolicy({ Identity: args.identity, Confirm: false });
    return text(`Deleted DLP policy: ${args.identity}`);
  },
  remove_dlp_rule: async (args) => {
    await dlp.removeRule({ Identity: args.identity, Confirm: false });
    return text(`Deleted DLP rule: ${args.identity}`);
  },
  create_endpoint_dlp_policy: async (args) => {
    const params = {
      Name: args.name,
      EndpointDlpLocation: args.endpoint_location?.length ? args.endpoint_location : ["All"],
    };
    Object.assign(
      params,
      dlp.createPolicyLocationExceptionParams({ endpoint: args.endpoint_location_exception })
    );
    if (args.mode) params.Mode = args.mode;
    if (args.comment) params.Comment = args.comment;
    assertLocationExceptions(params);
    return text(dlp.formatWriteResult("Create endpoint DLP policy", await dlp.createPolicy(params)));
  },
  create_endpoint_dlp_rule: async (args) => {
    assertEndpointNotify(args);
    const params = { Name: args.name, Policy: args.policy, ...dlp.ruleWriteParams(args) };
    return text(dlp.formatWriteResult("Create endpoint DLP rule", await dlp.createRule(params)));
  },
  create_copilot_dlp_policy: async (args) => {
    const params = {
      Name: args.name,
      Locations: dlp.copilotLocations(args.user_scope),
      EnforcementPlanes: ["CopilotExperiences"],
    };
    if (args.mode) params.Mode = args.mode;
    if (args.comment) params.Comment = args.comment;
    return text(dlp.formatWriteResult("Create Copilot DLP policy", await dlp.createPolicy(params)));
  },
  create_copilot_dlp_rule: async (args) => {
    const params = {
      Name: args.name,
      Policy: args.policy,
      ContentContainsSensitiveInformation: dlp.copilotCondition({
        sits: args.sensitive_information_types,
        labels: args.sensitivity_labels,
      }),
    };
    if (args.action === "block_web_search") params.RestrictWebGrounding = true;
    else params.RestrictAccess = [{ setting: "ExcludeContentProcessing", value: "Block" }];
    if (args.notify_user?.length) params.NotifyUser = args.notify_user;
    if (args.priority != null) params.Priority = args.priority;
    return text(dlp.formatWriteResult("Create Copilot DLP rule", await dlp.createRule(params)));
  },
  list_sensitive_information_types: async (args) => {
    const name = "list_sensitive_information_types";
    const scope = args.scope === "custom" ? "custom" : "all";
    const items = await dlp.listSensitiveInformationTypes(scope, args.name_contains);
    return pageResult(name, args, items, (page) => dlp.formatSitList(page, scope));
  },
};
