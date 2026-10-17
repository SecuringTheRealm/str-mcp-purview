"""Reconcile the approved roadmap migration; never blindly retry issue creation.

Run without --apply to produce the intended plan. Requires authenticated gh.
The manifest is a migration record, not a second live backlog.
"""
import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/backlog'
REPO = 'SecuringTheRealm/str-mcp-purview'
URL = f'https://github.com/{REPO}'
items = []

def add(key, kind, title, priority, parent, source, scope, criteria, status='backlog', deps=(), exception=None, existing=None):
    items.append(dict(key='roadmap-v1.' + key, kind=kind, title=title, priority=priority,
                      parent_key=('roadmap-v1.' + parent) if parent else None, source=source,
                      scope=scope, criteria=criteria, status=status,
                      dependency_keys=['roadmap-v1.' + d for d in deps],
                      parent_exception=exception, existing_number=existing))

E = 'Shared engineering/discovery work has no honest user-story boundary; task directly under its outcome epic.'
add('release', 'epic', 'Validate safe delivery of the expanded MCP surface', 'P0', None, 'README: Azure Functions; deletion confirmation; auto-labeling; issue #20', 'Release the implemented branch only after deployed authorization, readback and protocol gates pass. Existing local tests and selected local live reproductions are evidence, not deployed all-tool readiness.', 'All required validation children pass with sanitized evidence; SDK migration acceptance remains intact; no unsupported authentication combination is advertised as supported. Failed writes/readbacks and deletion completion are reconciled before release.', 'in-review')
add('sdk', 'task', 'Migrate to MCP TypeScript SDK v2 for the stateless MCP spec', 'P0', 'release', 'Existing issue #20 and PR #21', 'Preserve the original package migration and protocol-adoption spike obligations. v2 packages exist in the branch; review/release acceptance remains open.', 'Original issue acceptance remains authoritative: no codemod errors, package migration, tests and both transport smoke tests, and written spike outcome/follow-up. Do not close from branch implementation alone.', 'in-review', exception=E, existing=20)
add('http', 'task', 'Validate every capability through the deployed HTTP host', 'P0', 'release', 'README: Azure Functions In UAT; October validation issues 1–7', 'Run the disposable-object UAT matrix for 37 canonical capabilities, prompts/resources, Graph and SCC operations, full/compact/dispatcher modes, supported authentication candidates and isolated simulation connection.', 'Record versions and sanitized results; verify reads after writes and eventual deletion; exercise permission denial and unsupported combinations. Copilot grouped labels and DLP Confirm:false pass locally but must pass the deployed proxy; timeout recovery still needs live retest.', 'ready', deps=('sdk',), exception=E)
add('deletion', 'task', 'Prove caller-bound deletion confirmation on remote hosting', 'P0', 'release', 'README: elicited deletion confirmation', 'Verify trusted caller/client/tenant identity integration and all six deletion continuations. Current HTTP default cannot verify callers and intentionally fails closed.', 'Decline/cancel/malformed/expired/replayed/cross-caller requests never delete; stale target changes require new review; successful confirmation deletes only its bound object; logs contain no tenant payloads or credentials.', 'ready', exception=E)
add('autouat', 'task', 'Validate automatic-label policy lifecycle against a tenant', 'P0', 'release', 'ROADMAP: auto-label core implemented; README: auto-labeling UAT', 'Validate disabled creation, eligible publication, scopes, rule conditions, isolated simulation, actual status fields, diagnostics, revision guards, activation and removal. The ten core tools are implemented, not proven live.', 'Record actual policy/rule/simulation response shapes; completed unchanged simulation permits guarded activation; missing/changed evidence prevents it; verify readback and clean up disposable objects without claiming existing labels are reversed.', 'ready', exception=E)
add('autoscale', 'task', 'Define and implement trusted simulation state across workers', 'P1', 'release', 'README: process-local simulation records', 'Design shared trusted state or explicitly constrain supported deployments to one process. Bind simulation evidence to caller, tenant, configuration and completion; no fabricated human approval.', 'A restarted/different worker cannot enable from untrusted evidence; chosen supported topology is documented and tested; expiry, invalidation and concurrent-change limits are defined. This gates a multi-worker activation claim, not single-process UAT.', exception=E)
add('protection', 'epic', 'Complete verified label and DLP control coverage', 'P1', None, 'ROADMAP: Tier 1; August F4/F5/F8/F9/F11/F12', 'Extend existing operations where parameter boundaries fit; keep new tool families tied to distinct objects. Core label/DLP CRUD and auto-label CRUD already exist.', 'Required stories pass local contracts and live readback; unsupported mappings fail explicitly; new surfaces have verified documentation and least-privilege authorization. Future suggestions remain refinement scope until their constraints are checked.')
add('autoadv', 'story', 'Apply advanced automatic-label controls with explicit support limits', 'P1', 'protection', 'ROADMAP: auto-labeling; README: reserved options', 'As a Purview administrator, I want to configure supported advanced automatic-label rules, so that business targeting and matching requirements can be represented without silently weakening protection. Includes advanced expressions, multi-group matching, adaptive scopes, removal/library-default behavior, scheduled activation, overwrite, EDM/classifier and header/document-creator encodings; each is a separately verified slice, not a claim that all are currently supported.', 'Scenario: Verified option\n  Given a supported workload and eligible label\n  When I submit a verified advanced configuration\n  Then readback represents the requested control\nScenario: Unverified option\n  Given an option whose mapping or authorization is unverified\n  When I submit that option\n  Then the request fails explicitly without mutation')
add('automap', 'task', 'Verify and implement advanced auto-label mappings incrementally', 'P1', 'autoadv', 'README: FEATURE_UNAVAILABLE reserved schema fields', 'Produce a parameter/workload/version matrix and split independently testable slices before implementation; preserve the ten-tool policy/rule architecture unless a distinct object requires more. Include empty-list clearing and enabled semantics; internal-only rule priority remains excluded.', 'Every enabled field has official mapping plus live readback; unsupported fields retain explicit rejection. Scheduled activation includes reviewed authorization and cancellation; classifier enumeration feasibility is separate from rule references.')
add('conditions', 'story', 'Express remaining DLP conditions and exceptions', 'P1', 'protection', 'ROADMAP: DLP conditions; August F5', 'As a Purview administrator, I want to specify richer positive conditions and exceptions, so that legitimate transfers can be distinguished from prohibited ones. Includes non-Copilot label conditions and verified remaining ExceptIf fields; existing SIT tuning and common exceptions are implemented.', 'Scenario: Matched condition\n  Given a supported condition and workload\n  When I save the rule\n  Then readback preserves its matching and exception settings\nScenario: Unsupported combination\n  Given an incompatible condition combination\n  When I save the rule\n  Then validation rejects it before mutation')
add('conditionsmap', 'task', 'Map richer DLP predicates and workload compatibility', 'P1', 'conditions', 'ROADMAP: DLP condition richness', 'Define typed positive/exception schemas; verify Boolean encoding and workload restrictions. Do not expose arbitrary executable PowerShell or unchecked AdvancedRule payloads.', 'Tests cover mapping, mixed-condition boundaries, clearing/replacement semantics, permission checks and live readback; existing Copilot SIT/label mutual exclusion is preserved.')
add('actions', 'story', 'Configure remaining DLP remediation and incident reporting', 'P1', 'protection', 'ROADMAP: encrypt/RMS, quarantine, incident report; August F4', 'As a Purview administrator, I want to select supported remediation and incident-report settings, so that detected violations receive the required response and reporting. Incident-report recipients/content are distinct from alert recipients.', 'Scenario: Incident reporting\n  Given a supported rule and recipients\n  When I save reporting settings\n  Then readback contains GenerateIncidentReport and IncidentReportContent\nScenario: Unsupported action\n  Given an action unavailable to the selected workload\n  When I configure that action\n  Then the request fails without changing the rule')
add('incident', 'task', 'Add incident-report recipients and content parameters', 'P1', 'actions', 'August F4; ROADMAP: incident report', 'Add parameters to existing create_dlp_rule/set_dlp_rule; retain current read fields and existing notifications.', 'Map GenerateIncidentReport and IncidentReportContent; validate accepted values/recipients and update semantics; prove tenant readback. No extra tool for a setting.')
add('remediation', 'task', 'Verify encryption, quarantine and specialized endpoint actions', 'P2', 'actions', 'ROADMAP: DLP actions; OnPremisesScannerDlpRestrictions; UnallowedApps', 'Discover and implement verified encrypt/RMS, quarantine, on-premises scanner restrictions and UnallowedApps shapes as separable parameter slices.', 'Each action has documented workload support and typed shape; invalid mixtures reject before execution; live readback and action limitations are documented.')
add('scopes', 'story', 'Target additional DLP workloads and administrative units', 'P1', 'protection', 'ROADMAP: locations; August F11/F12', 'As a Purview administrator, I want to target supported additional workloads and administrative units, so that controls apply to the intended organizational boundary. Existing SharePoint/OneDrive/Teams/Endpoint exceptions are implemented.', 'Scenario: Supported target\n  Given a verified location surface or administrative unit\n  When I save the policy scope\n  Then readback contains that scope and preserves omitted fields\nScenario: Unverified target\n  Given an unverified location type\n  When I select that target\n  Then the request is rejected without broader implicit scope')
add('scopesmap', 'task', 'Verify remaining DLP locations and policy admin-unit parameters', 'P1', 'scopes', 'ROADMAP: on-prem scanner, PowerBI, third-party apps, adaptive scopes; August F12 recommendation', 'Confirm each location/API and map create/update/exclusion semantics. Administrative units on publishing and DLP policies are recommended refinement, distinct from implemented auto-label units.', 'Explicit per-workload surface matrix; verified PolicyRBACScopes exposure where supported; static/adaptive differences and RBAC tested; unsupported targets remain unavailable.')
add('ordering', 'task', 'Refine publishing-policy ordering parameters', 'P2', 'protection', 'August F9 recommendation; label policy setters', 'Proposed extension: next_label_policy/previous_label_policy on set_label_policy, after verifying mutual exclusion and backend behavior. This recommendation is not yet implementation.', 'Resolve the referenced policy; reject conflicting position requests; map NextLabelPolicy/PreviousLabelPolicy; verify resulting relative order by live readback.', exception=E)
add('classification', 'epic', 'Author and inspect reusable classification primitives', 'P1', None, 'ROADMAP: keyword dictionaries; SIT packages; custom SIT XML; EDM', 'Provide dictionary, SIT rule-package and EDM schema capabilities with validated data formats and identity-safe updates.', 'Read/export and each authoring story passes format checks, permission tests and live readback; original XML constraints are verified rather than assumed; package removal and dependent controls are reviewed safely.')
add('dictionary', 'story', 'Manage keyword dictionaries for classification', 'P1', 'classification', 'ROADMAP: Classification keyword dictionaries T1', 'As a Purview administrator, I want to manage keyword dictionaries, so that reusable large keyword sets can support classification rules.', 'Scenario: Dictionary update\n  Given a supported dictionary and valid terms\n  When I create or update its contents\n  Then readback contains the intended terms\nScenario: Invalid input\n  Given terms outside confirmed limits\n  When I submit the dictionary\n  Then validation rejects the request without mutation')
add('dictionarymap', 'task', 'Implement verified keyword dictionary operations', 'P1', 'dictionary', 'ROADMAP: *-DlpKeywordDictionary', 'Verify read/create/set/remove semantics, term encoding and limits; choose object-specific capabilities and deletion guard integration.', 'Canonical identity, pagination where needed, format boundaries, protected parameter passing and tenant CRUD readback are covered.')
add('sit', 'story', 'Inspect and safely author custom sensitive information types', 'P1', 'classification', 'ROADMAP: SIT rule-package read; Custom SIT write; August F6', 'As a Purview administrator, I want to inspect and author custom SIT packages, so that organization-specific identifiers can be detected without malformed package uploads. Structured authoring and validated caller-supplied XML are distinct supported input paths.', 'Scenario: Valid package\n  Given a validated package specification\n  When I submit the package\n  Then export/readback contains the intended SIT definitions\nScenario: Invalid package\n  Given malformed or unsupported XML\n  When I submit the package\n  Then local validation rejects it before upload')
add('sitread', 'task', 'Add SIT rule-package read and export', 'P1', 'sit', 'ROADMAP: Get-DlpSensitiveInformationTypeRulePackage', 'Implement safe package catalogue/detail/export, selecting a tool/resource contract without returning unbounded XML by default.', 'Built-in/custom identity distinctions, byte encoding and permission behavior verified; export is suitable for a subsequent version-aware update.')
add('sitwrite', 'task', 'Build validated custom SIT package create/update/remove', 'P1', 'sit', 'ROADMAP: XML builder/validator; August F6', 'Confirm regex restrictions, confidence/validator schema, Unicode encoding, package-size limits and dictionary rules (historical roadmap mentions 2048 terms/50-character terms/~770 KB; verify actual current limits). Updates export, mutate and reimport; preserve package IDs and existing definitions.', 'Structured authoring and validated XML import reject malformed/oversized/unsupported packages; stale export changes detected; live create/update/remove/readback works; dependency/removal consequences surfaced.', deps=('sitread',))
add('edm', 'story', 'Manage exact-data-match schemas safely', 'P1', 'classification', 'ROADMAP: *-DlpEdmSchema; August F6', 'As a Purview administrator, I want to manage EDM schemas, so that exact-match classifications use an explicit validated schema. Data upload or ingestion pipelines require separate scoping and are not silently included.', 'Scenario: Valid schema\n  Given a supported EDM schema definition\n  When I create or update it\n  Then readback contains its intended fields and identities\nScenario: Invalid schema\n  Given malformed or incompatible schema XML\n  When I submit it\n  Then validation rejects it without mutation')
add('edmmap', 'task', 'Verify and implement EDM schema XML lifecycle', 'P1', 'edm', 'ROADMAP: *-DlpEdmSchema (XML)', 'Verify XML constraints and Get/New/Set/Remove cmdlet availability; provide validated byte conversion and reviewed deletion.', 'Schema identity, update semantics, malformed input, RBAC and live lifecycle are proven; data ingestion remains explicitly outside this schema-only slice.')
add('visibility', 'story', 'Review DLP detections and report evidence', 'P1', 'classification', 'ROADMAP: Ops/visibility DLP alerts/detection reports', 'As a Purview administrator, I want to retrieve supported detection reports, so that control reviews can distinguish configuration from observed detections. Configuration presence alone is not enforcement proof.', 'Scenario: Report retrieval\n  Given authorized access and an explicit report range\n  When I request a supported report\n  Then the result identifies its source, range and available evidence\nScenario: Missing access\n  Given insufficient report permissions\n  When I request the report\n  Then access failure is explicit rather than reported as zero detections')
add('reports', 'task', 'Validate DLP report surfaces and bounded read contracts', 'P1', 'visibility', 'ROADMAP: Get-DlpDetailReport, Get-DlpDetectionsReport', 'Confirm current cmdlet availability, license/role requirements, retention windows, pagination and alert/report distinctions before implementation.', 'Bounded authorized retrieval and sensitive-content handling tested; unsupported or retired report surfaces documented without inventing empty results.')
add('ai', 'epic', 'Extend protection to verified enterprise AI surfaces', 'P2', None, 'ROADMAP: AI DLP Application; FeatureConfiguration capture', 'Add enterprise AI Application-plane configuration and separately scoped prompt/response capture. Existing Microsoft 365 Copilot phase-one tools are implemented.', 'Application and capture children meet verified API/auth constraints; deprecated Entra plane is not used; application integration and data-collection privacy remain explicit boundaries.')
add('aiapp', 'story', 'Configure DLP for Entra-registered enterprise AI applications', 'P2', 'ai', 'ROADMAP: Entra-registered AI apps/Microsoft Foundry', 'As a Purview administrator, I want to scope DLP to registered AI applications, so that sensitive prompts can be restricted through the supported Application enforcement plane. The application developer remains responsible for integrating processContent.', 'Scenario: Application policy\n  Given a verified registered application and supported predicates\n  When I configure its DLP rule\n  Then readback contains its application location and restriction\nScenario: Unsupported plane\n  Given the deprecated Entra enforcement-plane value\n  When I select that value\n  Then validation rejects it')
add('aiappmap', 'task', 'Build verified Application Locations and AdvancedRule encoding', 'P2', 'aiapp', 'ROADMAP: Locations + AdvancedRule builder', 'Confirm official JSON schemas and workload/action combinations; map Application not deprecated Entra; test RestrictAccess/RestrictWebGrounding only where supported. Discover external-email Copilot grounding preview separately.', 'Typed builders, supported combinations, permission boundaries and live readback verified; processContent application implementation is documented as excluded.')
add('capture', 'story', 'Configure reviewed AI prompt and response collection', 'P2', 'ai', 'ROADMAP: DSPM for AI FeatureConfiguration', 'As a Purview administrator, I want to configure authorized AI collection policies, so that approved investigations have the intended collection scope. This is a separate configuration family, not a side effect of DLP creation.', 'Scenario: Reviewed collection scope\n  Given an explicitly approved collection configuration\n  When I save the policy\n  Then readback identifies its intended collection scope\nScenario: Invalid scenario\n  Given an unsupported ScenarioConfig\n  When I submit it\n  Then the request fails without creating a collection policy')
add('capturemap', 'task', 'Verify FeatureConfiguration lifecycle and ScenarioConfig', 'P2', 'capture', 'ROADMAP: New/Set/Get/Remove-FeatureConfiguration', 'Verify cmdlets, JSON schema, licensing, RBAC and information-handling constraints before exposing reviewed CRUD operations.', 'Typed validation and live readback/removal proven; collection limits and retention/privacy implications documented; no automatic enabling from an assessment.')
add('retention', 'epic', 'Establish a coherent retention-label and policy solution', 'P2', None, 'ROADMAP: Retention labels & policies T2', 'Build the retention read model before writes; cover actions, review stages and adaptive scopes as verified slices.', 'Read-first model and safe write story pass authorized live lifecycle; irreversible or restricted changes are explicit; retention is not conflated with sensitivity labels.')
add('retentionstory', 'story', 'Inspect and configure supported retention controls', 'P2', 'retention', 'ROADMAP: ComplianceTag; RetentionCompliancePolicy', 'As a Purview administrator, I want to inspect and configure retention controls, so that records follow the intended lifecycle rather than a sensitivity-label policy.', 'Scenario: Read retention state\n  Given authorized access to retention configuration\n  When I inspect a retention label or policy\n  Then the result identifies its action, scope and review settings\nScenario: Unsupported change\n  Given an immutable or unsupported retention change\n  When I submit that change\n  Then it is rejected before mutation')
add('retentionread', 'task', 'Verify retention surfaces and implement read/formatter model', 'P2', 'retentionstory', 'ROADMAP: Get-ComplianceTag and retention policy model', 'Verify current label/policy/rule cmdlets, actions, review stages, adaptive scope semantics and permissions; read before authoring.', 'Raw identities and normalized actions/scopes are preserved; missing/unsupported fields not fabricated; documented write constraints produced.')
add('retentionwrite', 'task', 'Implement verified retention authoring slices', 'P2', 'retentionstory', 'ROADMAP: New/Set-ComplianceTag; New/Set-RetentionCompliancePolicy', 'Split independent retention authoring outcomes after read-model discovery; implement confirmed cmdlet mappings with safe updates and explicit irreversible-change constraints.', 'Tenant readback validates each supported write; unsupported action/stage/adaptive combinations fail locally; destructive/irreversible changes receive appropriate review.', deps=('retentionread',))
add('discovery', 'epic', 'Resolve feasibility of additional Purview planes', 'P2', None, 'ROADMAP: Tier 2 endpoint; Tier 3; new planes; README proposed elicitation; August F7/F10', 'Discovery backlog for uncertain surfaces; no claim that a portal feature has a supported API. Historical feasibility tiers are hypotheses, not priority or live lifecycle. No discovery item is marked blocked solely because an API is unverified.', 'Each child records official/live evidence, auth/data model and explicit build/defer decision; no invented endpoint, schedule, owner or production support claim.')
for key, title, source, scope, criteria in [
 ('endpointsettings', 'Discover endpoint tenant settings automation', 'ROADMAP: endpoint service-domain/app/USB/printer groups; browser settings', 'Inspect verified Get/Set-PolicyConfig or other documented surfaces for service domains, apps, USB/printer groups and browser cloud-upload/paste controls; these are not ordinary EndpointDlpRestrictions.', 'Produce API/role/workload matrix and read-only tenant evidence; separate portal-only steps; schedule writes only after mapping proof.'),
 ('classifiers', 'Discover supported trainable-classifier catalogue access', 'ROADMAP: Tier 3 classifier catalogue', 'Historical roadmap found no confirmed enumeration API; verify current documentation and safely inspect Get-Command *Classifier*/*TrainableClassifier* on a tenant. An undocumented command alone is not a production support guarantee.', 'Record supported API or evidence of current gap; if supported, define list/resource contract; if not, document defer decision. Do not invent external blocker ownership.'),
 ('network', 'Discover Network Data Security automation boundaries', 'ROADMAP: Network Data Security SASE/SSE', 'Verify classifier/policy cmdlet surfaces and partner/portal provisioning requirements; identify automation boundaries before scheduling.', 'Document supported control APIs, integration responsibilities, manual prerequisites and build/defer decision without assuming a partner integration can be automated.'),
 ('newplanes', 'Scope Insider Risk, Communications Compliance and DSPM read planes', 'ROADMAP: New solution planes', 'Produce separate feasibility briefs for Insider Risk Management, Communications Compliance and DSPM/DSPM for AI, verifying exact API families, classifier limits and permissions rather than treating generic Graph Security as sufficient.', 'Each brief identifies user outcome, read-first scope, official surface, scopes/RBAC and handling constraints; split implementation epics only after a scope decision.'),
 ('licensing', 'Refine tenant subscription and service-plan discovery', 'August F7 recommendation', 'Proposed Graph subscribedSkus read capability requires additional permissions. Tenant subscription availability does not prove individual user eligibility or every Purview entitlement.', 'Verify permission requirements and least-privilege alternative; design output separating purchased products, service plans and unknown user eligibility; document implementation decision.'),
 ('audit', 'Scope separate Exchange connection for audit enablement', 'August F10 deferral', 'Set-AdminAuditLogConfig is not an SCC operation; do not add it to the current IPPS connection. Investigate a separately authenticated Exchange Online capability only if prioritized.', 'Confirm supported Exchange command and auth/RBAC; document explicit defer/build decision and additional connection boundary. No tenant audit change during discovery.'),
 ('elicitation', 'Refine contextual business-rule elicitation without automatic deployment', 'README: Exploring elicitation of business requirements', 'Requirements elicitation is proposed, not registered. Define targeted questions only when business context/rules are missing, source/SOP provenance, reviewed draft intent, resumability and caller-bound continuations.', 'Define scalar-form versus document/editor boundaries; decline/cancel yields incomplete draft; review of intent never authorizes tenant writes; capability gaps and separate deployment authorization preserved.')]:
    add(key, 'task', title, 'P2', 'discovery', source, scope, criteria, exception=E)

def write(name, data):
    (OUT / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

def api(endpoint, method='GET', payload=None, paginate=False):
    args = ['gh', 'api', endpoint, '-X', method, '-H', 'Accept: application/vnd.github+json']
    if paginate:
        args += ['--paginate', '--slurp']
    if payload is not None:
        args += ['--input', '-']
    p = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                       capture_output=True, text=True, encoding='utf-8', timeout=90)
    if p.returncode:
        raise RuntimeError(f'{method} {endpoint}: {p.stderr.strip()}')
    value = json.loads(p.stdout) if p.stdout.strip() else None
    return [x for page in value for x in page] if paginate else value

def body(item, records=None):
    key = item['key']
    priority = item['priority']
    rationale = {'P0':'Mandatory before the affected deployment/release claim; this does not declare an incident.',
                 'P1':'Important extension of the established label/DLP/classification scope; no delivery date is assigned.',
                 'P2':'Future capability or refinement that can be deferred without breaching the present release gate.'}[priority]
    relation = []
    if item['parent_key']:
        relation.append('Parent: ' + (f"{REPO}#{records[item['parent_key']]['number']}" if records else item['parent_key']))
    for dep in item['dependency_keys']:
        relation.append('Blocked by: ' + (f"{REPO}#{records[dep]['number']}" if records else dep) + ' — completion/release gate; predecessor evidence is required, independent refinement may proceed.')
    if item['parent_exception']:
        relation.append('Engineering hierarchy exception: ' + item['parent_exception'])
    children = [i for i in items if i['parent_key'] == key]
    if children:
        relation.append('Children: ' + ', '.join(f"{REPO}#{records[i['key']]['number']}" if records else i['key'] for i in children))
    criteria = item['criteria']
    if item['kind'] == 'story':
        criteria = '```gherkin\n' + criteria + '\n```'
    return (f"<!-- product-owner:key={key} -->\n## Outcome and scope\n{item['scope']}\n\n"
            f"## {'Exit criteria' if item['kind']=='epic' else 'Acceptance criteria'}\n{criteria}\n\n"
            f"## Priority\n{priority} — {rationale}\n\n## Relationships\n" + '\n'.join(relation or ['No structural parent.']) +
            f"\n\n## Source and validation\nSource: {item['source']}.\n"
            f"Migration provenance: [preserved roadmap]({URL}/blob/feat/protocol-2-migration/docs/backlog/roadmap-before-migration.md) and [README]({URL}/blob/feat/protocol-2-migration/README.md). These migration files remain local until committed/pushed; the source key is the durable reconciliation identifier.\n\n"
            f"State: {item['status']}; owner unassigned; estimates/dates not agreed. No acceptance is claimed from mocked tests alone. Original roadmap implementation markers are preserved as historical baseline, not independently re-certified here.\n")

def apply():
    verification_file = OUT / 'migration-verification.json'
    if verification_file.exists() and json.loads(verification_file.read_text(encoding='utf-8')).get('verified'):
        raise RuntimeError('Migration already verified; reconcile subsequent human changes rather than reapplying initial state')
    existing = api(f'repos/{REPO}/issues?state=all&per_page=100', paginate=True)
    records = {}
    for issue in existing:
        if 'pull_request' in issue:
            continue
        for item in items:
            if f"<!-- product-owner:key={item['key']} -->" in (issue.get('body') or '') or issue['number'] == item['existing_number']:
                if item['key'] in records:
                    raise RuntimeError('Duplicate source key ' + item['key'])
                records[item['key']] = issue
    label_specs = {**{f'type:{t}': ('5319e7', f'Backlog record: {t}') for t in ('epic','story','task')},
                   **{f'priority:{p}': (c, d) for p,c,d in [('P0','b60205','Mandatory before affected release gate'),('P1','fbca04','Important core outcome'),('P2','c2e0c6','Deferrable future improvement')]},
                   **{f'status:{s}': ('1d76db', f'Delivery lifecycle: {s}') for s in ('backlog','ready','in-review')}}
    existing_labels = {l['name'] for l in api(f'repos/{REPO}/labels?per_page=100', paginate=True)}
    for name, (color,description) in label_specs.items():
        if name not in existing_labels:
            api(f'repos/{REPO}/labels', 'POST', dict(name=name,color=color,description=description))
    snapshots = {}
    for item in items:
        labels = [f"type:{item['kind']}",f"priority:{item['priority']}",f"status:{item['status']}"]
        if item['key'] not in records:
            record = api(f'repos/{REPO}/issues', 'POST', dict(title=item['title'],body=body(item),labels=labels))
            records[item['key']] = record
            write('migration-records.json', {k:{field:r[field] for field in ('number','id','node_id','html_url')} for k,r in records.items()})
            print(f"Created #{record['number']} {item['title']}", flush=True)
        else:
            record = records[item['key']]
            unrelated = [l['name'] for l in record['labels'] if not l['name'].startswith(('type:','priority:','status:'))]
            record = api(f"repos/{REPO}/issues/{record['number']}", 'PATCH', dict(labels=unrelated + labels))
            records[item['key']] = record
        snapshots[item['key']] = records[item['key']].get('body') or ''
    for item in items:
        record = records[item['key']]
        number = record['number']
        current = api(f'repos/{REPO}/issues/{number}')
        if (current.get('body') or '') != snapshots[item['key']]:
            raise RuntimeError(f'Concurrent body edit at #{number}; preserve it and reconcile manually')
        desired = body(item, records)
        if item['existing_number']:
            original = snapshots[item['key']]
            marker = '\n\n<!-- product-owner:managed-roadmap -->\n'
            original = original.split(marker)[0]
            desired = original + marker + desired
        api(f'repos/{REPO}/issues/{number}', 'PATCH', dict(body=desired))
        if item['parent_key']:
            parent = records[item['parent_key']]
            try:
                actual_parent = api(f'repos/{REPO}/issues/{number}/parent')
            except RuntimeError as exc:
                if 'HTTP 404' not in str(exc):
                    raise
                actual_parent = None
            if actual_parent and actual_parent['number'] != parent['number']:
                raise RuntimeError(f'Reparenting not authorized for #{number}')
            if not actual_parent:
                api(f"repos/{REPO}/issues/{parent['number']}/sub_issues", 'POST', {'sub_issue_id':record['id']})
        current_deps = api(f'repos/{REPO}/issues/{number}/dependencies/blocked_by?per_page=100', paginate=True)
        for dep in item['dependency_keys']:
            blocker = records[dep]
            if not any(d['id'] == blocker['id'] for d in current_deps):
                api(f'repos/{REPO}/issues/{number}/dependencies/blocked_by', 'POST', {'issue_id':blocker['id']})
        print(f"Linked/updated #{number}", flush=True)
    manifest = []
    for item in items:
        record = records[item['key']]
        row = dict(number=record['number'],kind=item['kind'],priority=item['priority'],status=item['status'],
                   parent=records[item['parent_key']]['number'] if item['parent_key'] else None,
                   blocked_by=[records[d]['number'] for d in item['dependency_keys']],source_key=item['key'])
        if item['parent_exception']:
            row['parent_exception'] = item['parent_exception']
        manifest.append(row)
    write('migration-manifest.json', dict(repository=REPO,items=manifest))
    write('migration-records.json', {k:{field:r[field] for field in ('number','id','node_id','html_url')} for k,r in records.items()})

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    keys = {i['key'] for i in items}
    assert len(keys) == len(items)
    assert all(i['parent_key'] in keys or i['parent_key'] is None for i in items)
    assert all(d in keys for i in items for d in i['dependency_keys'])
    write('migration-plan.json', dict(repository=REPO,items=items))
    print(json.dumps({'items':len(items),'counts':{k:sum(i['kind']==k for i in items) for k in ('epic','story','task')},'new':sum(i['existing_number'] is None for i in items)}),flush=True)
    if args.apply:
        apply()
