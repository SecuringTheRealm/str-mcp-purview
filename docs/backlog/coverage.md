# Roadmap source coverage

This maps the preserved roadmap and related review proposals to stable GitHub records. GitHub controls live state; the status in the migration plan is its initial classification. No historical acceptance obligation was removed.

| Source obligation | Record | Type |
| --- | --- | --- |
| README: Azure Functions; deletion confirmation; auto-labeling; issue #20 | [#22](https://github.com/SecuringTheRealm/str-mcp-purview/issues/22) Validate safe delivery of the expanded MCP surface | epic |
| Existing issue #20 and PR #21 | [#20](https://github.com/SecuringTheRealm/str-mcp-purview/issues/20) Migrate to MCP TypeScript SDK v2 for the stateless MCP spec | task |
| README: Azure Functions In UAT; October validation issues 1–7 | [#23](https://github.com/SecuringTheRealm/str-mcp-purview/issues/23) Validate every capability through the deployed HTTP host | task |
| README: elicited deletion confirmation | [#24](https://github.com/SecuringTheRealm/str-mcp-purview/issues/24) Prove caller-bound deletion confirmation on remote hosting | task |
| ROADMAP: auto-label core implemented; README: auto-labeling UAT | [#25](https://github.com/SecuringTheRealm/str-mcp-purview/issues/25) Validate automatic-label policy lifecycle against a tenant | task |
| README: process-local simulation records | [#26](https://github.com/SecuringTheRealm/str-mcp-purview/issues/26) Define and implement trusted simulation state across workers | task |
| ROADMAP: Tier 1; August F4/F5/F8/F9/F11/F12 | [#27](https://github.com/SecuringTheRealm/str-mcp-purview/issues/27) Complete verified label and DLP control coverage | epic |
| ROADMAP: auto-labeling; README: reserved options | [#28](https://github.com/SecuringTheRealm/str-mcp-purview/issues/28) Apply advanced automatic-label controls with explicit support limits | story |
| README: FEATURE_UNAVAILABLE reserved schema fields | [#29](https://github.com/SecuringTheRealm/str-mcp-purview/issues/29) Verify and implement advanced auto-label mappings incrementally | task |
| ROADMAP: DLP conditions; August F5 | [#30](https://github.com/SecuringTheRealm/str-mcp-purview/issues/30) Express remaining DLP conditions and exceptions | story |
| ROADMAP: DLP condition richness | [#31](https://github.com/SecuringTheRealm/str-mcp-purview/issues/31) Map richer DLP predicates and workload compatibility | task |
| ROADMAP: encrypt/RMS, quarantine, incident report; August F4 | [#32](https://github.com/SecuringTheRealm/str-mcp-purview/issues/32) Configure remaining DLP remediation and incident reporting | story |
| August F4; ROADMAP: incident report | [#33](https://github.com/SecuringTheRealm/str-mcp-purview/issues/33) Add incident-report recipients and content parameters | task |
| ROADMAP: DLP actions; OnPremisesScannerDlpRestrictions; UnallowedApps | [#34](https://github.com/SecuringTheRealm/str-mcp-purview/issues/34) Verify encryption, quarantine and specialized endpoint actions | task |
| ROADMAP: locations; August F11/F12 | [#35](https://github.com/SecuringTheRealm/str-mcp-purview/issues/35) Target additional DLP workloads and administrative units | story |
| ROADMAP: on-prem scanner, PowerBI, third-party apps, adaptive scopes; August F12 recommendation | [#36](https://github.com/SecuringTheRealm/str-mcp-purview/issues/36) Verify remaining DLP locations and policy admin-unit parameters | task |
| August F9 recommendation; label policy setters | [#37](https://github.com/SecuringTheRealm/str-mcp-purview/issues/37) Refine publishing-policy ordering parameters | task |
| ROADMAP: keyword dictionaries; SIT packages; custom SIT XML; EDM | [#38](https://github.com/SecuringTheRealm/str-mcp-purview/issues/38) Author and inspect reusable classification primitives | epic |
| ROADMAP: Classification keyword dictionaries T1 | [#39](https://github.com/SecuringTheRealm/str-mcp-purview/issues/39) Manage keyword dictionaries for classification | story |
| ROADMAP: *-DlpKeywordDictionary | [#40](https://github.com/SecuringTheRealm/str-mcp-purview/issues/40) Implement verified keyword dictionary operations | task |
| ROADMAP: SIT rule-package read; Custom SIT write; August F6 | [#41](https://github.com/SecuringTheRealm/str-mcp-purview/issues/41) Inspect and safely author custom sensitive information types | story |
| ROADMAP: Get-DlpSensitiveInformationTypeRulePackage | [#42](https://github.com/SecuringTheRealm/str-mcp-purview/issues/42) Add SIT rule-package read and export | task |
| ROADMAP: XML builder/validator; August F6 | [#43](https://github.com/SecuringTheRealm/str-mcp-purview/issues/43) Build validated custom SIT package create/update/remove | task |
| ROADMAP: *-DlpEdmSchema; August F6 | [#44](https://github.com/SecuringTheRealm/str-mcp-purview/issues/44) Manage exact-data-match schemas safely | story |
| ROADMAP: *-DlpEdmSchema (XML) | [#45](https://github.com/SecuringTheRealm/str-mcp-purview/issues/45) Verify and implement EDM schema XML lifecycle | task |
| ROADMAP: Ops/visibility DLP alerts/detection reports | [#46](https://github.com/SecuringTheRealm/str-mcp-purview/issues/46) Review DLP detections and report evidence | story |
| ROADMAP: Get-DlpDetailReport, Get-DlpDetectionsReport | [#47](https://github.com/SecuringTheRealm/str-mcp-purview/issues/47) Validate DLP report surfaces and bounded read contracts | task |
| ROADMAP: AI DLP Application; FeatureConfiguration capture | [#48](https://github.com/SecuringTheRealm/str-mcp-purview/issues/48) Extend protection to verified enterprise AI surfaces | epic |
| ROADMAP: Entra-registered AI apps/Microsoft Foundry | [#49](https://github.com/SecuringTheRealm/str-mcp-purview/issues/49) Configure DLP for Entra-registered enterprise AI applications | story |
| ROADMAP: Locations + AdvancedRule builder | [#50](https://github.com/SecuringTheRealm/str-mcp-purview/issues/50) Build verified Application Locations and AdvancedRule encoding | task |
| ROADMAP: DSPM for AI FeatureConfiguration | [#51](https://github.com/SecuringTheRealm/str-mcp-purview/issues/51) Configure reviewed AI prompt and response collection | story |
| ROADMAP: New/Set/Get/Remove-FeatureConfiguration | [#52](https://github.com/SecuringTheRealm/str-mcp-purview/issues/52) Verify FeatureConfiguration lifecycle and ScenarioConfig | task |
| ROADMAP: Retention labels & policies T2 | [#53](https://github.com/SecuringTheRealm/str-mcp-purview/issues/53) Establish a coherent retention-label and policy solution | epic |
| ROADMAP: ComplianceTag; RetentionCompliancePolicy | [#54](https://github.com/SecuringTheRealm/str-mcp-purview/issues/54) Inspect and configure supported retention controls | story |
| ROADMAP: Get-ComplianceTag and retention policy model | [#55](https://github.com/SecuringTheRealm/str-mcp-purview/issues/55) Verify retention surfaces and implement read/formatter model | task |
| ROADMAP: New/Set-ComplianceTag; New/Set-RetentionCompliancePolicy | [#56](https://github.com/SecuringTheRealm/str-mcp-purview/issues/56) Implement verified retention authoring slices | task |
| ROADMAP: Tier 2 endpoint; Tier 3; new planes; README proposed elicitation; August F7/F10 | [#57](https://github.com/SecuringTheRealm/str-mcp-purview/issues/57) Resolve feasibility of additional Purview planes | epic |
| ROADMAP: endpoint service-domain/app/USB/printer groups; browser settings | [#58](https://github.com/SecuringTheRealm/str-mcp-purview/issues/58) Discover endpoint tenant settings automation | task |
| ROADMAP: Tier 3 classifier catalogue | [#59](https://github.com/SecuringTheRealm/str-mcp-purview/issues/59) Discover supported trainable-classifier catalogue access | task |
| ROADMAP: Network Data Security SASE/SSE | [#60](https://github.com/SecuringTheRealm/str-mcp-purview/issues/60) Discover Network Data Security automation boundaries | task |
| ROADMAP: New solution planes | [#61](https://github.com/SecuringTheRealm/str-mcp-purview/issues/61) Scope Insider Risk, Communications Compliance and DSPM read planes | task |
| August F7 recommendation | [#62](https://github.com/SecuringTheRealm/str-mcp-purview/issues/62) Refine tenant subscription and service-plan discovery | task |
| August F10 deferral | [#63](https://github.com/SecuringTheRealm/str-mcp-purview/issues/63) Scope separate Exchange connection for audit enablement | task |
| README: Exploring elicitation of business requirements | [#64](https://github.com/SecuringTheRealm/str-mcp-purview/issues/64) Refine contextual business-rule elicitation without automatic deployment | task |

## Preserved baseline and exclusions

The original roadmap's shipped baseline, feasibility rules, tier definitions and contribution guidance are retained verbatim in [roadmap-before-migration.md](roadmap-before-migration.md). Completed CRUD, authoritative label reads, per-SIT tuning, notifications, common exceptions, locations and Copilot/Endpoint phase-one configuration were not recreated as unstarted work. Their live/deployed release claims are covered by the release-validation epic.

Historical "no API", regex, byte-size and platform claims require current official/live verification before implementation; discovery issues capture that obligation. No inferred external blocker is assigned an invented owner. Proposed licensing, ordering and publishing/DLP administrative-unit additions remain refinement rather than an implementation promise. Audit enablement stays outside the current SCC connection. Requirements elicitation remains a proposed draft-intent workflow, with deployment separately authorized.

The original baseline's future `label-taxonomy-health` prompt lens remains a parked refinement idea; it is not delivered or scheduled, and this migration does not promote it into a committed implementation story.

Existing #19 (human review), #6 (Glama publishing), #3/#4 (closed Allstar security records) are unrelated and unchanged. #20 retains its human-authored body and original acceptance checklist, with a separately delimited migration section. No managed issue was closed.
