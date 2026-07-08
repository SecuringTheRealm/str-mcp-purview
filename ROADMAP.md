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

Baseline so the gaps below are legible. 10 tools, 2 prompts, 2 resources.

- **Labels (read):** `list_sensitivity_labels`, `get_sensitivity_label`, `get_label_policy_settings`
- **DLP (read):** `list_dlp_policies`, `get_dlp_policy`, `list_dlp_rules`
- **DLP (write):** `create_dlp_policy`, `create_dlp_rule`, `set_dlp_rule`
- **SITs (read):** `list_sensitive_information_types` + `purview://sit-catalog` and `.../custom` resources
- **Prompts:** `dlp-policy-review`, `label-coverage-audit`

---

## 🟢 Tier 1 — Ready to build

These sit on cmdlets we can reach through the existing PowerShell bridge today.
No new plane, no XML, no new auth.

> **✅ Shipped: `set_dlp_policy` (change an existing policy's mode).** Closes the
> test → enforce lifecycle — `Set-DlpCompliancePolicy -Mode`. Was the
> highest-value missing write; now done. Remaining DLP write gaps below.

### Sensitivity-label write (create / modify)
- **Surface:** `New-Label`, `Set-Label`, `Remove-Label` (Security & Compliance PowerShell).
- **Why now:** same `Connect-IPPSSession` session the DLP tools already use. A
  minimal create is just `-DisplayName -Name -Tooltip`; the large surface of
  encryption, content-marking, watermarking and Teams-protection parameters is
  all **optional** and can be layered in incrementally.
- **Proposed tools:** `create_sensitivity_label`, `set_sensitivity_label`.
- **Watch-outs:** the cmdlet is enormous (100+ parameters). Start with a lean,
  documented subset and expand on demand rather than mirroring every switch.

### Sensitivity-label publishing
- **Surface:** `New-LabelPolicy`, `Set-LabelPolicy`, `Remove-LabelPolicy` (Security & Compliance PowerShell).
- **Why it matters:** a created label does **nothing** until it's published to
  users via a label policy. Creation without publishing is a half-feature — pair
  these with the write tools above.
- **`New-LabelPolicy` params:** mandatory `-Name` and `-Labels` (which labels the
  policy publishes); targeting via `-ExchangeLocation` and `-ModernGroupLocation`
  (M365 Groups). Behaviour (mandatory labeling, default label, etc.) is set
  through an `-AdvancedSettings` **hashtable**, not named switches.
- **Design notes (differ from DLP — don't copy the DLP shapes blindly):**
  - **Create = publish. There is no separate publish/run step** — `New-LabelPolicy`
    publishes on completion; there's no draft state and no republish verb. The
    only delay is automatic client-side replication (minutes up to ~24h), which
    is not an admin action. The tool's success message must not imply *instant*
    end-user availability.
  - **No test/enforce mode.** Unlike DLP there is no `Mode` dial for label
    policies. Posture behaviour lives in `-AdvancedSettings`, e.g.
    `@{OutlookDefaultLabel="General"}`, `@{TeamworkMandatory="True"}` — the same
    settings `get_label_policy_settings` already *reads*.
  - **Only Exchange + M365 Group targeting is real.** On `New-LabelPolicy`,
    `-SharePointLocation` / `-OneDriveLocation` / `-SkypeLocation` are documented
    "reserved for internal Microsoft use" — expose `-ExchangeLocation` and
    `-ModernGroupLocation` (plus `All`), *not* the SharePoint/OneDrive params the
    DLP tools use.
- **Proposed tools:** `create_label_policy`, `set_label_policy` (with an
  `advanced_settings` map surfacing mandatory-labeling / default-label /
  downgrade-justification).

### Round out DLP write
- **Surface:** `Remove-DlpCompliancePolicy`, `Remove-DlpComplianceRule`.
- **✅ Done — `set_dlp_policy`:** change an existing policy's mode
  (`Set-DlpCompliancePolicy -Mode`), closing the test → enforce loop. Shipped.
- **Remaining gap:** no **delete** for either policies or rules.
- **Proposed tools:** `remove_dlp_policy`, `remove_dlp_rule`.

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
