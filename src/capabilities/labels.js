import * as labels from "../labels.js";
import { text, pageResult } from "./shared.js";

export const handlers = {
  list_sensitivity_labels: async (args) => {
    const name = "list_sensitivity_labels";
    const items = labels.filterLabels(await labels.listLabels(), { active: args.active, parent: args.parent });
    return pageResult(name, args, items, labels.formatLabelList);
  },
  get_sensitivity_label: async (args) => {
    return text(labels.formatLabelDetail(await labels.getLabel(args.label_id)));
  },
  list_label_policies: async (args) => {
    const name = "list_label_policies";
    return pageResult(name, args, await labels.listLabelPolicies(), labels.formatLabelPolicyList);
  },
  get_label_policy: async (args) => {
    return text(labels.formatLabelPolicyDetail(await labels.getLabelPolicy(args.identity)));
  },
  get_label_policy_settings: async (args) => {
    return text(labels.formatPolicySettings(await labels.getLabelPolicySettings()));
  },
  create_sensitivity_label: async (args) => {
    const params = { Name: args.name, ...labels.labelSettingsParams(args) };
    if (args.parent_id) params.ParentId = args.parent_id;
    return text(labels.formatWriteResult("Create sensitivity label", await labels.createLabel(params)));
  },
  set_sensitivity_label: async (args) => {
    const params = { Identity: args.identity, ...labels.labelSettingsParams(args) };
    return text(labels.formatWriteResult("Set sensitivity label", await labels.setLabel(params)));
  },
  create_label_policy: async (args) => {
    const params = { Name: args.name, Labels: args.labels };
    if (args.exchange_location?.length) params.ExchangeLocation = args.exchange_location;
    if (args.modern_group_location?.length) params.ModernGroupLocation = args.modern_group_location;
    if (args.advanced_settings) params.AdvancedSettings = args.advanced_settings;
    if (args.comment) params.Comment = args.comment;
    return text(labels.formatWriteResult("Create label policy", await labels.createLabelPolicy(params)));
  },
  set_label_policy: async (args) => {
    const params = { Identity: args.identity };
    if (args.add_labels?.length) params.AddLabels = args.add_labels;
    if (args.remove_labels?.length) params.RemoveLabels = args.remove_labels;
    if (args.advanced_settings) params.AdvancedSettings = args.advanced_settings;
    if (args.comment) params.Comment = args.comment;
    return text(labels.formatWriteResult("Set label policy", await labels.setLabelPolicy(params)));
  },
  remove_sensitivity_label: async (args) => {
    await labels.removeLabel({ Identity: args.identity, Confirm: false });
    return text(`Deleted sensitivity label: ${args.identity}`);
  },
  remove_label_policy: async (args) => {
    await labels.removeLabelPolicy({ Identity: args.identity, Confirm: false });
    return text(`Deleted label policy: ${args.identity}`);
  },
};
