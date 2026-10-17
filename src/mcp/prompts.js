import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
const PROMPTS = [
  {
    name: "dlp-control-review",
    description:
      "Deep-dive audit of DLP control quality — whether policies/rules are well-built, non-conflicting, correctly scoped, alerted, and enforce-ready. Classifies findings as Effectiveness (data not protected) or Hygiene, never by severity. Complements data-security-posture. Read-only.",
    arguments: [
      { name: "policy", description: "Optional: focus the review on a single DLP policy (name or GUID).", required: false },
    ],
  },
  {
    name: "data-security-posture",
    description:
      "Assess the tenant's data-security posture by tracing whether classifications (SITs, labels) translate into ENFORCED controls. Ranks gaps by where the protection chain breaks and recommends fixes. Read-only.",
    arguments: [
      {
        name: "business_context",
        description:
          "Optional: the org's industry, jurisdictions, regulatory obligations, and sensitive data handled — used to judge which protections should exist.",
        required: false,
      },
    ],
  },
];

function promptMessage(t) {
  return { messages: [{ role: "user", content: { type: "text", text: t } }] };
}

function getPrompt(name, args = {}) {
  const meta = PROMPTS.find((p) => p.name === name);
  switch (name) {
    case "data-security-posture": {
      const providedContext = args?.business_context
        ? `\n\n**Business context provided by the practitioner:** ${args.business_context}\nTreat this as authoritative for the Step 1 judgment (basis: [from stated context]).`
        : "";
      return {
        description: meta.description,
        ...promptMessage(
          `Assess this Microsoft Purview tenant's DATA-SECURITY POSTURE by tracing whether classifications translate into ENFORCED controls. This is read-only analysis — make no changes.${providedContext}

## Step 1 — Establish business context first
The "should you be protecting X?" judgment needs business context this tool does not have. In order:
1. If business context was provided (above or from the wider workflow — industry, jurisdictions, regulatory obligations, sensitive data handled), use it.
2. Otherwise, briefly ASK the practitioner for it.
3. If still unavailable, INFER a profile hypothesis from the deployment's own signals — label names, custom SIT names, the built-in SITs already used in policies, policy names/comments, and covered workloads (e.g. "EU org handling financial + health data"). State it explicitly as a hypothesis to confirm.
Tag every recommendation later with its basis: **[from stated context]** or **[inferred — confirm]**.

## Step 2 — Gather evidence (bounded — do NOT enumerate all built-in SITs)
Call: list_dlp_policies, list_dlp_rules (no filter), list_sensitivity_labels, get_label_policy_settings, and list_sensitive_information_types with scope "custom" ONLY.
Do not list all SITs — the 280+ built-ins are noise. The only built-in SITs that matter are those actually referenced by rules; read those from the rules. Use get_dlp_policy / get_dlp_rule / get_sensitivity_label for detail on specific flagged items only.

## Step 3 — Trace the protection chain
For each classification primitive walk: DEFINE → REFERENCE (used by a policy) → ENFORCE (policy mode Enable, rule enabled, blocking action set) → COVER (workloads/scope). Direction depends on whether the org opted in:
- CUSTOM SITs and LABELS (org-created): start from the catalog — an item referenced by NO enforced policy is a real gap; they built it to be used.
- BUILT-IN SITs: consider only those referenced by rules; never treat an unused built-in as a gap.
- LABELS have two protection paths — their own encryption OR an enforced DLP rule that references them. A label not published by any label policy breaks at the first link (it cannot even be applied).

## Step 4 — Report
**Business context & profile** — what you established, with provenance.
**Posture summary** — headline: how much of the org's classification reaches an enforced control; counts of policies, labels, custom SITs.
**Findings — grouped by where the chain breaks, NOT by severity.** An **Effectiveness** gap means classification does not reach enforced protection; a **Hygiene** issue is quality, not protection. Tag each **[config]** (fact) or **[assessment]** (judgement).
- **Not enforced** (reference→enforce) — references sensitive data but sits in a Test mode or is disabled. You cannot measure time-in-test (no mode-change history): show WhenCreated + WhenChangedUTC and treat a test policy as *stalled* only when age suggests it — a recent or just-created policy is in-progress, not a finding. [Effectiveness]
- **Not controlled** (define→reference) — custom SITs or labels not enforced by any policy; published labels with neither encryption nor a DLP reference. [Effectiveness]
- **Partially enforced** (enforce→cover) — enforced but narrow scope, missing workloads, or detect-without-block. [Effectiveness]
- **Hygiene** — weak governance (mandatory-labeling off, no default label) or taxonomy smells: quality, not protection.
- **Context-driven** — protections expected given the business profile but absent (each with a [basis] tag).
**Prioritised recommendations** — concrete next steps, each naming the tool to use (e.g. set_dlp_policy to promote to enforce, create_dlp_rule to cover a SIT, create_label_policy to publish an orphaned label) and its [basis] tag. Do not perform them — this is analysis only.`
        ),
      };
    }

    case "dlp-control-review": {
      const scopeNote = args?.policy
        ? `\n\n**Scope:** review only the DLP policy "${args.policy}" — use get_dlp_policy for it and list_dlp_rules with policy set to it.`
        : "";
      return {
        description: meta.description,
        ...promptMessage(
          `Deep-dive audit of this tenant's DLP CONTROLS — whether they are well-built, non-conflicting, correctly scoped, properly alerted, and ready to enforce. Read-only — make no changes.${scopeNote}

This complements data-security-posture: that prompt asks "does classification reach enforcement?" (breadth); this asks "are the DLP controls themselves well-built and enforce-ready?" (depth). Do not re-derive the classification-coverage chain here — defer that to data-security-posture.

## Step 1 — Gather evidence (bounded)
Call list_dlp_policies and list_dlp_rules. Then call get_dlp_policy / get_dlp_rule ONLY on items you flag (test-mode, over-broad, broad high-priority rules, heavy-block) to pull their locations and exceptions — the detail reads carry those; the list reads do not. Do not drill into every item.

## Step 2 — Assess. Classify each finding two independent ways:
- CLASS — **Effectiveness** (the control does not actually protect — data slips through) or **Hygiene** (it works but is sub-optimal / hard to maintain).
- BASIS — **[config]** (a fact read from settings) or **[assessment]** (your judgement — state the reasoning).
Do NOT assign risk severities — the practitioner applies their own risk lens.

Assess:
**Enforcement readiness**
- Stalled test-mode policy — in a Test mode and apparently not progressing to enforcement. You CANNOT measure time-in-test (no mode-change history); use WhenCreated + WhenChangedUTC as a proxy and ALWAYS show both dates. A recently created/changed policy — or one created earlier in this conversation — is in-progress, NOT a finding. [Effectiveness, assessment]
- Promotion-ready — a well-formed test policy (rules + actions + notifications) that looks ready; recommend set_dlp_policy to promote IF intended. [Effectiveness, assessment]
- Disabled rule inside an enabled policy — dead logic. [Effectiveness, config]
**Correctness & conflicts**
- Priority shadowing — a broad, high-priority rule (few conditions, or StopPolicyProcessing) ahead of more specific lower-priority rules that may then never fire. [Effectiveness, assessment]
- Monitor-only — detects SITs/labels but sets no BlockAccess/RestrictAccess (matches are logged only; may be intentional — say so). [Effectiveness, assessment]
- Block-without-notify — blocks but no NotifyUser/policy tip (users get no explanation). [Hygiene, config]
**Scope & targeting** (use the enriched get_dlp_policy Locations)
- Over-broad — All-locations with a hard block (disruption risk). [Effectiveness, assessment]
- Workload gap — a data type protected in one workload (e.g. Exchange) but not others where it flows (Endpoint/Teams/Copilot). [Effectiveness, config+assessment]
- Heavy exceptions — many ExceptIf* conditions that may quietly defeat the rule. [Effectiveness, assessment]
- Overlapping policies on the same workload — precedence confusion. [Hygiene, config]
**Alerting & hygiene**
- Blind enforcement — a blocking rule with GenerateAlert unset. [Hygiene, config]
- Severity mismatch — high-impact rule with no/low ReportSeverityLevel. [Hygiene, config]
- Undocumented policy — no Comment. [Hygiene, config]
- Duplicate rules — same SITs + actions across policies. [Hygiene, assessment]

## Step 3 — Report
**Scope** — tenant-wide, or the single policy reviewed.
**Enforcement summary** — mode distribution (enforce vs test vs disabled); note any promotion-ready.
**Effectiveness findings** (first) — each states the concrete consequence factually (e.g. "detects credit-card numbers but takes no action — matches are logged only"), with its [basis]; for test-mode items include the WhenCreated / WhenChangedUTC dates.
**Hygiene findings** (second).
Within each group, present findings — do NOT rank them.
**Recommendations** — concrete next steps, each naming the tool (set_dlp_policy to promote/change mode, set_dlp_rule to enable/add a block or notification, remove_dlp_rule for dead duplicates) and its [basis]. Do not perform them — analysis only.`
        ),
      };
    }

    default:
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown prompt: ${name}`);
  }
}


export { PROMPTS, getPrompt };

