import * as auto from "../auto-labels.js";
import { pageResult } from "./shared.js";
const result = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
const wanted = (values, identity) => values.some(v => String(v?.Guid ?? v?.Name ?? v ?? "").toLowerCase() === identity.toLowerCase());
export const handlers = {
  list_auto_label_policies: async args => {
    const items = (await auto.listPolicies()).filter(p =>
      (!args.name_contains || String(p.Name).toLowerCase().includes(args.name_contains.toLowerCase())) &&
      (!args.mode || p.Mode === args.mode) && (args.enabled === undefined || p.Enabled === args.enabled) &&
      (!args.behaviour || auto.behaviour(p) === args.behaviour) &&
      (!args.label_identity || wanted([p.ApplySensitivityLabel], args.label_identity)) &&
      (!args.workload || (Array.isArray(p.Workload) ? p.Workload.includes(args.workload) : String(p.Workload ?? "").includes(args.workload)) || Boolean(p[{ SharePoint: "SharePointLocation", OneDriveForBusiness: "OneDriveLocation", Exchange: "ExchangeLocation" }[args.workload]]?.length)));
    return pageResult("list_auto_label_policies", args, items, page => JSON.stringify(page), item => ({ ...item, behaviour: auto.behaviour(item) }));
  },
  get_auto_label_policy: async args => result(await auto.getPolicy(args.identity, args)),
  create_auto_label_policy: async args => result(await auto.createPolicy(args)),
  set_auto_label_policy: async args => result(await auto.setPolicy(args)),
  remove_auto_label_policy: async args => result(await auto.removePolicy(args)),
  list_auto_label_rules: async args => {
    const items = (await auto.listRules(args.policy_identity)).filter(r =>
      (!args.name_contains || String(r.Name).toLowerCase().includes(args.name_contains.toLowerCase())) &&
      (!args.workload || r.Workload === args.workload) && (args.disabled === undefined || r.Disabled === args.disabled));
    return pageResult("list_auto_label_rules", args, items, page => JSON.stringify(page), item => item);
  },
  get_auto_label_rule: async args => result(await auto.getRule(args.identity, args)),
  create_auto_label_rule: async args => result(await auto.createRule(args)),
  set_auto_label_rule: async args => result(await auto.setRule(args)),
  remove_auto_label_rule: async args => result(await auto.removeRule(args)),
};
