# Roadmap

This document tracks where **str-mcp-purview** is going. It is organised by
**feasibility tier** — not by how much we'd *like* a feature, but by whether a
usable API surface actually exists to build it on. That distinction is the whole
game with Purview: the portal exposes far more than any documented API does, so
some obvious-sounding features have no programmatic hook at all.

For what already ships, see the [README](README.md). For how the two-plane
hybrid works, see the "Why a hybrid design" section there.

## How we decide what's buildable

Every capability here is scored against the two planes the server can act on:

| Plane | Auth | Reads | Writes |
| --- | --- | --- | --- |
| **Microsoft Graph** (`/beta/security/informationProtection`) | delegated token (`@azure/identity`) | ✅ labels, policy settings | ❌ none exposed |
| **Security & Compliance PowerShell** (`Connect-IPPSSession`) | delegated sign-in, one persistent `pwsh` | ✅ DLP, SITs, labels | ✅ DLP, SITs, labels |

Three rules follow from this:

1. **PowerShell is the only write plane.** Anything that mutates tenant config
   goes through the existing `pwsh` bridge, as the signed-in admin, honouring
   their RBAC.
2. **"No cmdlet, no feature."** If a capability has no documented cmdlet *and*
   no Graph endpoint, it is **blocked** and lands in Tier 3 until we verify
   otherwise against a live tenant — we do not build against assumed APIs.
3. **XML is a complexity multiplier.** Cmdlets that take simple named parameters
   are cheap. Cmdlets that require a hand-built rule-package XML (custom SITs)
   are a different class of work and are tiered accordingly.

## Feasibility tiers

| Tier | Meaning |
| --- | --- |
| 🟢 **T1 — Ready** | Documented cmdlet/endpoint on a plane we already use. Mostly parameter-mapping work. Build next. |
| 🟡 **T2 — Feasible, complex** | Surface exists but needs real machinery (XML generation/validation, new auth scope, multi-call orchestration). |
| 🔴 **T3 — Blocked** | No confirmed programmatic surface. Portal-only today. Needs live-tenant discovery before it can be scheduled. |
| 🔭 **New plane** | A whole new solution area (its own auth scope / API family). Larger than a single tool; scoped separately when we get there. |

---

## Ships today

Baseline so the gaps below are legible. **24 tools, 2 prompts, 3 resources.**

- **Labels (read):** `list_sensitivity_labels`, `get_sensitivity_label`, `get_label_policy_settings`
- **Labels (write):** `create_sensitivity_label`, `set_sensitivity_label`, `create_label_policy`, `set_label_policy`
- **DLP (read):** `list_dlp_policies`, `get_dlp_policy`, `list_dlp_rules`
- **DLP (write):** `create_dlp_policy`, `set_dlp_policy`, `create_dlp_rule`, `set_dlp_rule`
- **Endpoint & Edge DLP:** `create_endpoint_dlp_policy`, `create_endpoint_dlp_rule`
- **Copilot DLP:** `create_copilot_dlp_policy`, `create_copilot_dlp_rule`
- **SITs (read):** `list_sensitive_information_types`
- **List filters (client-side):** labels (`active`, `parent`), DLP policies (`mode`, `workload`), DLP rules (`policy`, `disabled_only`, `blocking_only`), SITs (`scope`, `name_contains`)
- **Resources:** `purview://label-catalog`, `purview://sit-catalog`, `purview://sit-catalog/custom`
- **Prompts (analysis layer):** `data-security-posture` (front door — protection-chain traversal, opt-in SIT direction, elicit/infer business context with provenance), `dlp-control-review` (DLP depth — control quality/enforce-readiness; Effectiveness/Hygiene classes not severity; `[config]`/`[assessment]` provenance; stalled-test-mode via age proxy). *(`label-coverage-audit` retired; `dlp-policy-review` evolved into `dlp-control-review`. Future: a `label-taxonomy-health` lens.)*

---

## Coverage scorecard — what's left, by tier

Every remaining DLP / label / classification gap, mapped to the tier it belongs in.

| Area | Gap | Cmdlet(s) | Tier |
| --- | --- | --- | --- |
| DLP CRUD | ✅ Rule read `get_dlp_rule` — **shipped** (single rule by `identity`, or all rules in a `policy`) | `Get-DlpComplianceRule` | ✅ done |
| DLP CRUD | ✅ Delete policy / rule — **shipped** (`remove_dlp_policy`, `remove_dlp_rule`) | `Remove-DlpCompliancePolicy` / `-DlpComplianceRule` | ✅ done |
| DLP CRUD | Edit policy **locations** (today `set_dlp_policy` = mode/comment only) | `Set-DlpCompliancePolicy` | 🟢 T1 |
| DLP CRUD | `set_`/`remove_` for endpoint & Copilot rules | `Set-DlpComplianceRule` | 🟢 T1 |
| DLP conditions | Richer rule conditions/actions (labels, doc-props, sender/recipient, file-type; encrypt/RMS, quarantine, incident report) | `*-DlpComplianceRule` | 🟢 T1 → 🟡 |
| DLP locations | Teams, on-prem scanner, PowerBI, 3rd-party-app locations + exceptions/adaptive scopes | `New-DlpCompliancePolicy` | 🟢 T1 |
| Labels | ✅ Delete label / policy — **shipped** (`remove_sensitivity_label`, `remove_label_policy`) | `Remove-Label` / `Remove-LabelPolicy` | ✅ done |
| Labels | **Auto-labeling** (apply by condition) | `*-AutoSensitivityLabelPolicy` + `...Rule` | 🟢 T1 |
| Classification | Keyword dictionaries | `*-DlpKeywordDictionary` | 🟢 T1 |
| Classification | SIT rule-package read | `Get-DlpSensitiveInformationTypeRulePackage` | 🟢 T1 |
| Ops/visibility | DLP alerts / detection reports | `Get-DlpDetailReport`, `Get-DlpDetectionsReport` | 🟢 T1 |
| Classification | **Custom SIT** write (rule-package XML) | `*-DlpSensitiveInformationTypeRulePackage` | 🟡 T2 |
| Classification | **EDM** (exact data match) schemas | `*-DlpEdmSchema` (XML) | 🟡 T2 |
| AI DLP | Entra-registered / Foundry app DLP | `New-DlpComplianceRule` + `Locations` | 🟡 T2 |
| AI capture | Prompt/response collection policies | `*-FeatureConfiguration` | 🟡 T2 |
| Endpoint | Tenant endpoint settings (service-domain / app / USB / printer groups) | — (discovery needed) | 🟡 T2 / ❓ |
| Classification | Trainable classifiers | — (no API) | 🔴 T3 |
| AI DLP | Network Data Security (SASE/SSE) | portal/partner Security Store | 🔴 T3 |

**Cheapest high-value next picks (all 🟢 T1):** **auto-labeling** (completes the label story), then **keyword dictionaries**, then DLP rule condition/action richness. *(Basic CRUD now closed: `get_dlp_rule` + DLP/label delete all shipped.)*

---

## 🟢 Tier 1 — Ready to build

These sit on cmdlets we can reach through the existing PowerShell bridge today.
No new plane, no XML, no new auth.

> **✅ Shipped: `set_dlp_policy` (change an existing policy's mode).** Closes the
> test → enforce lifecycle — `Set-DlpCompliancePolicy -Mode`. Was the
> highest-value missing write; now done. Remaining DLP write gaps below.

### ✅ Sensitivity-label write & publish — shipped
- **Tools:** `create_sensitivity_label` / `set_sensitivity_label` (`New-/Set-Label`);
  `create_label_policy` / `set_label_policy` (`New-/Set-LabelPolicy`).
- **Full settings surface shipped** (not a lean subset): encryption (incl.
  per-identity `rights_definitions`), content marking (header/footer/watermark),
  container protection (Groups/Teams/SharePoint), Teams meeting protection —
  exposed as category-grouped objects flattened to the flat `New-Label` params.
- **Publishing:** create = publish (no separate step); behaviour via
  `advanced_settings` hashtable; targets Exchange + M365 Groups.
- **Note:** labels are now hybrid — read via Graph, **write via PowerShell**
  (writes need `pwsh` + IPPSSession, unlike the Graph-only reads).
- **✅ Delete — shipped:** `remove_sensitivity_label`, `remove_label_policy`.
- **Remaining label gap:** **auto-labeling**
  (`New-/Set-/Remove-AutoSensitivityLabelPolicy` + `...Rule`) — see coverage below.

### Round out DLP write
- **✅ Done — `set_dlp_policy`:** change an existing policy's mode
  (`Set-DlpCompliancePolicy -Mode`), closing the test → enforce loop.
- **✅ Done — delete:** `remove_dlp_policy`, `remove_dlp_rule`
  (`Remove-DlpCompliancePolicy` / `-DlpComplianceRule`, `-Confirm:$false`).
- **✅ Done — rule read:** `get_dlp_rule` (single rule, or all rules in a policy).
- **✅ Done — detail-read enrichment:** `get_dlp_policy` / `get_dlp_rule` now select a
  richer property set (granular locations + exclusions; rule exceptions,
  `RestrictAccess`, `StopPolicyProcessing`, incident report, policy tip),
  summarised by the formatters — list reads stay lean. Unblocks scope/exception
  hygiene (dimension **C**) for the DLP deep-dive analysis. *(Verify exact
  `ExceptIf*`/location property names on a live tenant.)*
- **Remaining gap:** policy **location** editing (`set_dlp_policy` = mode/comment only).

### DLP surface coverage (locations & enforcement planes)
The traditional and endpoint surfaces are done; the rest ride the *same*
`*-DlpCompliancePolicy` / `*-DlpComplianceRule` cmdlets, differing only in
location params, enforcement planes, and action shapes.

- **✅ Done — traditional M365:** Exchange / SharePoint / OneDrive locations, block/notify/alert actions.
- **✅ Done — Endpoint & Microsoft Edge:** `create_endpoint_dlp_policy` (`EndpointDlpLocation`) + `create_endpoint_dlp_rule` (`EndpointDlpRestrictions`). Covers on-device activities and Edge inline browser DLP (`PasteToBrowser`, cloud upload). Kept as **separate tools** so the traditional DLP schemas stay lean.
  - *Follow-ups:* `set_endpoint_dlp_rule` (tune audit→block); Teams location on the traditional policy; `OnPremisesScannerDlpRestrictions`.
  - *Out of tool scope:* blocking *specific* AI/cloud domains needs tenant sensitive-service-domain settings, configured in the portal.
- **🟡 AI DLP (Copilot / Foundry / enterprise AI):** all ride the same
  `*-DlpCompliancePolicy` / `*-DlpComplianceRule` cmdlets; the common enabler is a
  **`Locations` + `AdvancedRule` JSON builder** plus the AI-specific actions
  (`RestrictAccess`, `RestrictWebGrounding`) — the same JSON-authoring complexity
  multiplier as custom SITs. Three distinct sub-variants, ranked by fit:
  1. **⭐ Entra-registered AI apps & Microsoft Foundry — best fit.** DLP for these
     is **PowerShell-only; the Purview portal cannot create them** ("you must use
     the `New-DlpComplianceRule` cmdlet"). Exactly this server's niche (no Graph,
     no portal). Scope a policy to the app's Entra ID via `Locations` JSON +
     `EnforcementPlanes=("Application")`, block prompts by SIT. *(App honours it by
     integrating the Purview `processContent` Graph API — developer's job, out of
     our scope.)* **Note:** `Entra` enforcement plane is deprecated → use `Application`.
  2. **✅ Microsoft 365 Copilot & Copilot Chat — shipped (phase 1).**
     `create_copilot_dlp_policy` + `create_copilot_dlp_rule`. Covers 3 of 4
     protections: block sensitive prompts (`RestrictAccess` ExcludeContentProcessing),
     block web grounding (`RestrictWebGrounding`), exclude labeled content. Label
     conditions use a `ContentContainsSensitiveInformation` **hashtable** with a
     `labels` group — **no AdvancedRule JSON needed** (that's only for cross-
     condition-type Boolean logic). Constraint enforced: SIT and label conditions
     can't share a rule. *Deferred:* external-email grounding (preview) — needs
     condition-param discovery. *Verify on live tenant:* Copilot location GUID,
     `ExcludeContentProcessing` setting string.
  3. **Prompt/response capture (DSPM for AI).** A **separate cmdlet family** —
     `New`/`Set`/`Get`/`Remove-FeatureConfiguration` with a `ScenarioConfig` JSON.
     Enables capturing prompts/responses for enterprise & unmanaged AI apps. New
     surface on the same SCC PowerShell plane.
- **🔴 Network Data Security (SASE/SSE inline, non-Edge):** classifier/policy half
  is cmdlet-reachable, but adds a SASE / secure-browser integration provisioned
  through the portal/partner Security Store — not fully PowerShell-automatable.
  Discovery needed before scheduling.

### SIT rule-package read
- **Surface:** `Get-DlpSensitiveInformationTypeRulePackage`.
- **Why now:** read-only, trivial, and it's the natural precursor to the Tier-2
  custom-SIT write work (you export a package before you can sensibly author
  one). Good stepping stone.
- **Proposed tool / resource:** `list_sit_rule_packages` or a
  `purview://sit-rule-packages` resource.

---

## 🟡 Tier 2 — Feasible but complex

The surface exists, but the work is materially harder than parameter-mapping.

### Custom SIT write (create / modify)
- **Surface:** `New-DlpSensitiveInformationTypeRulePackage -FileData`,
  `Set-DlpSensitiveInformationTypeRulePackage`.
- **Why it's T2, not T1:** these cmdlets don't take friendly parameters — they
  take a **complete rule-package XML** as a byte blob. Authoring that correctly
  means generating and validating XML against real constraints:
  - regex patterns allow only a **single capturing group**; lookarounds and
    greedy quantifiers get rejected at upload;
  - confidence levels, keyword lists, keyword **dictionaries** (for >2048
    keywords or >50-char terms), and validators each have schema rules;
  - the file must be **Unicode-encoded**, and the deserialised package is capped
    (~770 KB practical limit).
  - Modify is export → mutate XML → re-import, not an in-place edit.
- **Shape of the work:** an XML builder + validator layer, not just a cmdlet
  wrapper. Sensible to split into "author from a structured spec" and "validate
  before upload" so bad packages fail locally, not at the tenant.
- **Proposed tools:** `create_custom_sit`, `set_custom_sit` (spec-in,
  XML-generated internally).

### Retention labels & policies
- **Surface:** `New-/Set-/Get-ComplianceTag` (labels) and
  `New-/Set-RetentionCompliancePolicy` (policies), Security & Compliance PowerShell.
- **Why T2:** cmdlets are clean, but retention has its own model (retention
  actions, review stages, adaptive scopes) that needs its own read/formatter
  layer before writes make sense. A coherent mini-solution, not a one-tool add.

---

## 🔴 Tier 3 — Blocked (no confirmed surface)

Do not schedule these until the surface is proven on a live tenant.

### Trainable classifier catalog
- **Status:** **blocked.** Unlike SITs, there is **no confirmed documented
  PowerShell cmdlet or Graph API** to enumerate trainable classifiers (built-in
  *or* custom). All current documentation drives management through the Purview
  portal only. Retraining published custom classifiers isn't even supported in
  the portal.
- **Before building — discovery step:** in a live `Connect-IPPSSession`, run
  `Get-Command *Classifier*` / `*TrainableClassifier*` and check for any
  undocumented surface. Only if something real turns up does this graduate to a
  tier with a date. Until then it stays here.
- **If it graduates:** mirror the SIT catalog — a `list_trainable_classifiers`
  tool + `purview://classifier-catalog` resource — so it slots into the same
  mental model as SITs.

---

## 🔭 New solution planes (larger efforts)

Each of these is a new API family / auth scope — bigger than a single tool and
scoped as its own workstream when prioritised. Listed roughly by how self-
contained the surface is.

- **Insider Risk Management** — Microsoft Graph Security API (alerts / incidents,
  advanced hunting). New Graph scopes; read-first.
- **Communications Compliance** — policy read/review. Note: only *Microsoft-
  provided* trainable classifiers are supported here, which interacts with the
  Tier-3 blocker above.
- **DSPM / DSPM for AI** — data security posture. Surface maturity to be assessed;
  likely read-first posture reporting before any write.

---

## Contributing to the roadmap

When proposing an item, state its **tier and the surface** it rests on
(cmdlet name or Graph endpoint). "Portal can do X" is not sufficient — if there's
no documented cmdlet or endpoint, it's Tier 3 by definition, and the useful
contribution is the *discovery* that proves or disproves a surface exists.
