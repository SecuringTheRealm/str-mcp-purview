// Live reproduction of the October 2026 Copilot condition and setter findings.
// Requires delegated Purview access and explicitly supplied authentication settings.
// Only uniquely named objects created by this run are changed or removed.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { powershell } from "../src/powershell.js";
import { executeCapability } from "../src/dispatch/execute.js";

const tag = `ZZZ_MCP_REPLICATION_${randomUUID().slice(0, 8)}`;
const results = { run: tag, started: new Date().toISOString(), checks: [], cleanup: [] };
const policies = [], rules = [];
const asArray = x => x == null ? [] : Array.isArray(x) ? x : [x];
const names = { policy: `${tag}_DLP`, rule: `${tag}_Rule`, copilot: `${tag}_Copilot`, old: `${tag}_OriginalLabels`, revised: `${tag}_RevisedLabels` };
async function check(name, fn) {
  const start = Date.now();
  try {
    const evidence = await fn();
    const result = { name, status: "returned", elapsed_ms: Date.now() - start, evidence };
    results.checks.push(result); console.log(JSON.stringify(result)); return evidence;
  } catch (error) {
    const result = { name, status: "error", elapsed_ms: Date.now() - start, error: error.message };
    results.checks.push(result); console.log(JSON.stringify(result)); return undefined;
  }
}
async function readRule(identity) {
  const objects = asArray(await powershell.invoke("Get-DlpComplianceRule", { Identity: identity }, ["Name", "Guid", "Disabled", "ContentContainsSensitiveInformation", "RestrictAccess"]));
  return objects.find(x => x.Name === identity || String(x.Guid).toLowerCase() === identity.toLowerCase()) ?? null;
}
async function ownedRemove(cmdlet, name, destination) {
  if (!name.startsWith(`${tag}_`)) throw new Error("Cleanup target does not belong to this run.");
  try {
    const found = asArray(await powershell.invoke(cmdlet === "Remove-DlpComplianceRule" ? "Get-DlpComplianceRule" : "Get-DlpCompliancePolicy", { Identity: name }, ["Name", "Guid", "Mode"])).find(x => x.Name === name);
    if (!found) { destination.push({ name, status: "not_found" }); return; }
    if (!found.Guid) throw new Error("Cleanup requires the exact object's GUID.");
    await powershell.invoke(cmdlet, { Identity: found.Guid, Confirm: false });
    destination.push({ name, identity: found.Guid, status: "removal_submitted" });
  } catch (error) { destination.push({ name, status: "cleanup_failed", error: error.message }); }
}

try {
  // Authenticate through the same bridge used by the implementation; no tokens logged.
  const connected = await check("authenticated_read", async () => {
    const items = asArray(await powershell.invoke("Get-DlpCompliancePolicy", {}, ["Guid"]));
    return { visible_policy_count: items.length };
  });
  if (!connected) throw new Error("Purview authentication/read access was not established; no test objects created.");

  const label = await check("select_existing_published_leaf_label", async () => {
    const labels = asArray(await powershell.invoke("Get-Label", {}, ["Name", "Guid", "IsLabelGroup", "ParentId"]));
    const publishing = asArray(await powershell.invoke("Get-LabelPolicy", {}, ["Labels"]));
    const refs = publishing.flatMap(p => asArray(p.Labels)).map(x => String(x?.Guid ?? x?.Name ?? x).toLowerCase());
    const chosen = labels.find(l => l.Guid && l.IsLabelGroup !== true && !labels.some(c => String(c.ParentId?.Guid ?? c.ParentId).toLowerCase() === String(l.Guid).toLowerCase()) && refs.some(r => [l.Name, l.Guid].some(v => String(v).toLowerCase() === r)));
    if (!chosen) throw new Error("No existing published leaf label could be resolved; Copilot checks will be skipped.");
    return { identity: chosen.Guid };
  });

  policies.push(names.policy);
  const created = await check("create_disposable_test_policy", async () => {
    await executeCapability("create_dlp_policy", { name: names.policy, mode: "TestWithoutNotifications", exchange_location: ["All"], comment: "Disposable reproduction; never enable." });
    const p = asArray(await powershell.invoke("Get-DlpCompliancePolicy", { Identity: names.policy }, ["Name", "Guid", "Mode"])).find(x => x.Name === names.policy);
    if (p?.Mode !== "TestWithoutNotifications") throw new Error("Test mode could not be verified; no rule will be created.");
    return p;
  });
  if (created) {
    rules.push(names.rule);
    const original = await check("create_disposable_rule", async () => {
      await executeCapability("create_dlp_rule", { name: names.rule, policy: names.policy, sensitive_information_types: ["Credit Card Number"], block_access: true });
      const r = await readRule(names.rule); if (!r) throw new Error("Created rule was not readable."); return r;
    });
    if (original) {
      await check("original_setter_without_confirm_false", () => powershell.invoke("Set-DlpComplianceRule", { Identity: original.Guid, Disabled: true }, ["Guid", "Disabled"]));
      await check("readback_after_original_setter", () => readRule(names.rule));
      await check("current_setter_with_confirm_false", async () => {
        const before = await readRule(names.rule); if (!before || typeof before.Disabled !== "boolean") throw new Error("Cannot verify the rule's current disabled state.");
        const desired = !before.Disabled;
        await executeCapability("set_dlp_rule", { identity: before.Guid, disabled: desired });
        const after = await readRule(names.rule);
        return { desired_disabled: desired, readback: after, verified: after?.Disabled === desired };
      });
    }
  }
  if (label) {
    policies.push(names.copilot);
    const copilot = await check("create_disposable_copilot_test_policy", async () => {
      await executeCapability("create_copilot_dlp_policy", { name: names.copilot, mode: "TestWithoutNotifications", comment: "Disposable reproduction; never enable." });
      const p = asArray(await powershell.invoke("Get-DlpCompliancePolicy", { Identity: names.copilot }, ["Name", "Guid", "Mode"])).find(x => x.Name === names.copilot);
      if (p?.Mode !== "TestWithoutNotifications") throw new Error("Copilot test mode could not be verified."); return p;
    });
    if (copilot) {
      rules.push(names.old);
      await check("original_copilot_label_condition", async () => {
        await powershell.invoke("New-DlpComplianceRule", { Name: names.old, Policy: names.copilot, ContentContainsSensitiveInformation: [{ groups: [{ operator: "Or", labels: [{ name: label.identity, type: "Sensitivity" }] }] }], RestrictAccess: [{ setting: "ExcludeContentProcessing", value: "Block" }] });
        return readRule(names.old);
      });
      rules.push(names.revised);
      await check("current_copilot_label_condition", async () => {
        await executeCapability("create_copilot_dlp_rule", { name: names.revised, policy: names.copilot, sensitivity_labels: [label.identity], action: "block_processing" });
        const r = await readRule(names.revised); if (!r) throw new Error("Created Copilot rule was not readable."); return r;
      });
    }
  }
} catch (error) {
  results.error = error.message; console.error(error.message);
} finally {
  for (const name of rules.reverse()) await ownedRemove("Remove-DlpComplianceRule", name, results.cleanup);
  for (const name of policies.reverse()) await ownedRemove("Remove-DlpCompliancePolicy", name, results.cleanup);
  results.finished = new Date().toISOString();
  await mkdir("artifacts", { recursive: true });
  const path = `artifacts/${tag}.json`;
  await writeFile(path, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ report: path, cleanup: results.cleanup }));
  // Close the persistent PowerShell child after all work and evidence are saved.
  powershell.proc?.kill();
  process.exitCode = results.error || results.checks.some(c => c.evidence?.verified === false) || results.cleanup.some(c => c.status === "cleanup_failed") ? 1 : 0;
}
