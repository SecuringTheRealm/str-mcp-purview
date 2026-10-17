# Design notes

> Moved from the README. Setup lives in [README.md](../README.md).

## Architecture

```
index.js            stdio entry point (local MCP server)
functions/server.js Azure Functions custom-handler entry (stateless streamable HTTP)
host.json           Functions custom-handler wiring
src/server.js       MCP transport registration + createServer() factory
src/capabilities/   Capability registry, schemas and domain handlers
src/mcp/            Full/compact/dispatcher projections and shared prompts
src/retrieval/      Permission/metadata filters and deterministic BM25 ranking
src/dispatch/      Shared argument validation and authorized execution
src/graph.js        Graph token (@azure/identity, delegated or app-only cert) + raw beta fetch
src/powershell.js   Persistent pwsh IPPSSession bridge (request-scoped frames, base64 params)
src/labels.js       Sensitivity-label data access + formatters
src/dlp.js          DLP data access (read/write) + formatters
src/format.js       Shared token-efficient formatting helpers
```

The PowerShell bridge passes model-supplied parameters as a base64-encoded JSON blob rebuilt with `ConvertFrom-Json -AsHashtable`, keeping arguments out of the executable script text (no command injection). Requests are serialised, and every request's output is framed with **request-scoped unique markers** — a timed-out command's late output can never be mis-attributed to a later call, and marker-lookalike text in tenant data cannot spoof a frame. On a command timeout the pwsh child is killed and the next call reconnects cleanly. All exposed tools declare MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so hosts can gate destructive calls.

### Extending and evaluating the capability catalogue

1. Implement the handler in a capability/domain module, delegating to the integration layer. It must not register an MCP tool.
2. Define it with `defineCapability` from `src/capabilities/contract.js`: explicit ID, domain, operation type, read/write action, risk, destructive/idempotent/open-world flags, description, keywords, closed input schema, handler, constraints and examples. Permissions, scope alternatives, feature gates and aliases are optional. Operation types are extensible strings: `validate`, `publish` and `export` are no different from CRUD. Safety comes from explicit metadata, never a new operation's name.
3. Compose that definition into the exported catalogue in `src/capabilities/registry.js`. All modes discover it from that array. Existing operations use a compatibility adapter over `definitions.js`, domain handler maps and `examples.js`; new operations need not follow that legacy layout. No registration or dispatch switch needs editing.
4. Add handler, schema, permission and representative retrieval tests. Registry validation rejects duplicate IDs/aliases, invalid schemas/examples and inconsistent safety metadata before serving requests.

Existing-domain capabilities join compact operation enums automatically. New domains receive read/manage groups automatically, so tool count grows with domain/action groups, not individual operations. Dispatcher always has three tools. Compact schema size still grows with operation enums; choose dispatcher if constant initial disclosure is more important than domain-level approval boundaries. Reserved/generated tool-name collisions fail startup rather than silently shadowing a tool.

New handlers can use `capabilityResult(data, summary)` from `src/capabilities/results.js` to return structured data with concise text. Lists should reuse `createListPaginator` and its `{items,count,total_count,has_more,next_cursor}` contract. Declare output schemas where practical. Legacy detail/write text results are intentionally preserved. `executionKind` currently accepts only `immediate`: future jobs need a separately designed start/status/cancel contract, not a hidden polling loop or a fabricated completed result.

Run `npm test` and `npm run benchmark:retrieval`. The benchmark emits JSON containing each prompt, expected capability, ranked top-N IDs, hit, rank and elapsed milliseconds, plus tool counts and schema byte sizes for each mode. It exits nonzero on a missed expected capability. The initial ten-query set is a regression fixture, not evidence of general routing accuracy: expand it with real prompts and near-miss cases as the catalogue grows. No LLM is used for evaluation.

The ranking function accepts only the already-filtered catalogue. `searchCapabilities` accepts an injectable ranker, providing a seam for a future non-generative reranker without changing projections or bypassing filtering. BM25 is deliberately the initial implementation: local, inspectable, deterministic and without extra deployment or model costs.

Run `npm run benchmark:simulation` for a deterministic scripted-agent evaluation against **160 synthetic capabilities** across four domains and eight operation types. It selects the top candidate without consulting the expected answer, describes its schema, validates supplied task arguments, and executes against fake state. JSON output includes candidate rankings, actual invocations/results, byte counts, latency and denial checks; failures return a nonzero exit code. Tests also compare a 32-entry catalogue to 160 entries, exercise new-domain routing, confirmation, aliases, policy failures and pagination. See [the reviewed simulation findings](../benchmarks/SIMULATION_REVIEW.md).

This simulation proves contracts and routing behaviour for the fixture, not real-model task success, Microsoft API availability or live Azure authorization. The synthetic definitions are only imported by benchmarks/tests, never registered in the production catalogue. Production stdio and Functions HTTP tests separately exercise search → describe → execute and denied disclosure. No new real Purview operation or external dependency is introduced.

## Elicitation for deletion confirmation

All six delete capabilities use a shared execution guard in full, compact and dispatcher modes. Call the tool with `identity`; the four original delete tools retain the optional compatibility argument `confirm: true`, which has no authority to skip review. Auto-label delete tools do not accept that argument. A form identifies the configured tenant, resolved object name/GUID and deletion consequence. Confirmation defaults to false. Decline, cancel, malformed answers and clients without form support never invoke a removal cmdlet.

On MCP `2026-07-28`, the server returns `resultType: "input_required"` with an embedded `elicitation/create`. The client retries the same tool and arguments with the returned `requestState` and `inputResponses.confirm_deletion`. On legacy stdio, the server uses the SDK's in-call form request. See the [MRTR specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) and [elicitation specification](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).

The guard resolves the backend GUID, binds a five-minute review to the caller, client, tenant, capability and arguments, and checks the selected backend configuration again before deleting by GUID. DLP policy review also includes its rule count and selected rule configuration. Changed targets require a new review. Modern reviews use random opaque handles referencing server-owned records and are consumed before execution; simultaneous retries cannot execute the same review twice. Authorization is checked before review and again on the resolved identity. The check and removal are separate backend operations, not an atomic transaction.

Local stdio uses its process/connection boundary as the caller identity. HTTP integrations must supply `confirmationPrincipal` and a verified client identity (`confirmationClientId` or validated `authInfo.clientId`) to `createServer` from trusted authentication middleware. Never derive these from tool arguments, unverified headers or client-provided profile information. **The supplied Functions host does not currently provide a verified caller identity, so deletion fails closed there**, even with a Functions key. A Functions key alone does not identify the end user. Legacy stateless HTTP cannot perform the in-call interaction.

Pending reviews are bounded to 1,000 records per process. They survive fresh HTTP Server instances in that process, but not process restart or routing to another worker. Multi-worker deployment needs a shared store with atomic consumption before enabling deletion; retries on another worker currently fail safely. `MCP_CURSOR_SECRET` does not provide a shared deletion-review store. Failed/uncertain mutations are not automatically retried. Elicitation relies on the client to present a real user interaction; it is not independent evidence of human approval against a malicious client.

## Service-side automatic sensitivity labeling

Ten capabilities are registered in the `labels` domain: `list/get/create/set/remove_auto_label_policy` (lists use the plural `policies`) and the equivalent rule operations (plural `rules`). In compact mode use `purview_labels` for reads and `purview_manage_labels` for writes; describe the chosen capability for its closed schema and examples. The full catalogue has 37 capabilities; compact and dispatcher retain eight and three tools respectively.

Documented mappings implemented: policy/rule reads, list filters and cursor pagination, explicitly disabled apply-policy creation, published leaf-label validation, static SharePoint/OneDrive/Exchange targeting, selected scope replacement and location deltas, comments, policy priority, administrative-unit references, Exchange manual-label overwrite and external-mail RMS owner, supported simple SIT conditions/exceptions, rule reporting/error settings, disabling, simulation submission, distribution retry, optional diagnostics, configuration revisions, and elicited deletion. Omitted update fields remain unchanged. Condition arrays replace their field; empty condition-list clearing is unavailable until its backend semantics are verified. Disabling/deleting a policy does not reverse labels already applied.

Example sequence (substitute your tenant's eligible published label and site):

```json
{"name":"Finance auto-label","behaviour":"apply","label_identity":"Confidential","locations":{"sharepoint":{"selection":"selected","include_sites":["https://contoso.sharepoint.com/sites/Finance"]}}}
```

Pass that object to `create_auto_label_policy`. Create a rule with `create_auto_label_rule`:

```json
{"name":"Financial identifiers","policy_identity":"Finance auto-label","workload":"SharePoint","conditions":{"sensitive_information":{"operator":"any","groups":[{"name":"Financial","operator":"any","detectors":[{"kind":"sit","identity":"Credit Card Number","min_count":1,"confidence_level":"High"}]}]}}}
```

Then call `set_auto_label_policy` with `{"identity":"Finance auto-label","mode":"TestWithoutNotifications","restart_simulation":true}`. Simulation is submitted through an isolated SCC process using `Connect-IPPSSession -EnableSearchOnlySession`, with a module capability check. It returns submission/readback rather than waiting for a scan. Verify the authentication/module path and simulation status on a licensed disposable tenant before deployment. [Microsoft's simulation connection guidance](https://learn.microsoft.com/en-us/purview/apply-sensitivity-label-automatically#use-powershell-for-auto-labeling-policies).

Use `get_auto_label_policy` with `include_simulation_status`, `include_progress`, `include_distribution_detail`, or `include_administrative_unit_details`. Individual simulation samples are not exposed; review them in the Purview portal. Raw backend diagnostics are returned only when available; missing fields are not fabricated. The adapter conservatively recognizes completed status from `TestModeStatus`, `SimulationStatus`, or `TestModeResults.Status`; actual tenant response shapes must be verified, otherwise enabling fails closed. [Policy getter reference](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-autosensitivitylabelpolicy?view=exchange-ps).

Enable through `set_auto_label_policy` using `mode:"Enable"` and `expected_revision` from a fresh read. The guard requires a completed simulation initiated through this process, unchanged policy/rule/label fingerprints, and an active rule. Simulation records are process-local: restart or another worker requires re-simulation; production multi-worker support needs a shared trusted store. This is eligibility checking, not independent evidence of human approval. Host authorization and Microsoft RBAC still apply. Effective configuration/rule changes require disabling first; changes clear scheduled activation and require new simulation. There is no atomic backend lock between validation and mutation. An accepted mutation with failed readback returns `READBACK_FAILED` and must be inspected before retrying.

Reserved schema options return `FEATURE_UNAVAILABLE`, without mutation: removal/library-default behavior, adaptive scopes, OneDrive group targeting, cross-workload overwrite, scheduled auto-enable, the separate `enabled` flag, advanced expressions, EDM/trainable classifiers, document-creator/header encodings, and condition-list clearing. Simple detector matching currently supports one OR group. Rule priority and other internal-only cmdlet parameters are not exposed. See [policy update](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/set-autosensitivitylabelpolicy?view=exchange-ps) and [rule reference](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/new-autosensitivitylabelrule?view=exchange-ps). These limitations are explicit adapter gates, not additional tool families. Live label compatibility, licensing, publication targets, permissions, workload conditions, and service response shapes remain UAT gates; mocked tests do not prove live enforcement.

## Exploring elicitation of business requirements

This section is a proposed workflow, not a registered tool or automatic policy compiler. The existing `data-security-posture` prompt already accepts free-text `business_context`; elicitation could turn that into reviewed, structured control intent. Microsoft's [DLP design guidance](https://learn.microsoft.com/en-us/purview/dlp-policy-design) starts with business needs and a policy intent statement, then maps that intent to configuration.

The proposed flow is: **source policies/SOPs → candidate business rules → targeted questions → approved control intent → capability assessment → proposed configuration and tests → separately authorized deployment**. Requirement approval authorizes the interpretation, not a tenant write.

Use a few short form rounds, skipping information already established and asking only about material gaps or contradictions:

| Round | Decisions to elicit | Example question |
| --- | --- | --- |
| Business context | Process, business owner, outcome, source authority/version, affected teams | Which process does this rule protect, and who owns the policy? |
| Data and activities | Data categories, sensitivity, recognisable evidence, workloads and recipients | Does “customer information” mean contact details, payment details, or both? |
| Business rules | Allowed/prohibited activity, destinations, scope, exceptions and approval conditions | Is external sharing prohibited everywhere, or permitted through an approved service? |
| Operational behaviour | Block/warn/audit, permitted overrides, alert owner, pilot scope and rollback | Who receives an alert, and can users continue with a justification? |
| Review | Restated intent, unresolved assumptions, source conflicts, representative examples | Does this interpretation correctly capture the policy, including its exceptions? |

For each question, explain which proposed control it changes. Include “unknown” or “needs policy-owner review” where appropriate; do not make a missing answer silently select broad scope or enforcement. Treat decline/cancel as an incomplete assessment. Offer corrections and a resumable draft rather than repeating mandatory questions indefinitely. Forms can collect scalar decisions and enumerated selections; complex SOPs and nested rule structures need document access or an editor rather than one large elicitation form. Do not request credentials or real sensitive customer records as examples.

The output should be a versioned **control-intent record**, distinct from tool arguments:

- Intent ID/version; business process, owner and objective.
- Source document identifier/version, section and evidence for each rule; distinguish quoted requirements from inferred interpretations and user decisions.
- Actor, data category/detection evidence, activity, destination, workload/scope and desired outcome.
- Exception conditions, approval owner, expiry/review date and whether overrides are allowed.
- Proposed action, notification/alert owner, rollout mode, success criteria and rollback trigger.
- Unresolved questions/conflicts and per-rule status: supported by this server, requires an extension, requires another control/system, or not technically enforceable.
- Links to the eventual backend policy/rule GUIDs and read-back evidence after a separately authorized deployment.

Example: an SOP says “Payroll files must use the approved provider transfer process; emergency exports need manager approval.” Elicitation should establish how payroll content is recognised, which users/workloads are in scope, the approved destination/process, and whether an emergency exception is per-transfer and time-limited. Only then propose matching DLP and classification controls. A broad recipient-domain exclusion is not automatically equivalent to an approved transfer workflow. Manager approval requires a verifiable approval signal or external process; a user-entered justification does not establish that approval.

Before generating configuration, describe the permitted capabilities and validate each mapping against its actual schema and workload semantics. Current tools expose label configuration/publication and traditional, Endpoint and Copilot DLP; richer detectors, arbitrary conditions and many governance controls remain outside this server's implemented surface. Label creation alone does not classify existing content. Unsupported requirements must remain explicit gaps, not be approximated silently. Tenant discovery should verify existing labels/SITs, resource identities, overlapping controls and deployment prerequisites.

Build positive, negative and exception examples for each requirement: forbidden transfer blocked, legitimate transfer allowed, approved exception handled, ambiguous classification flagged. These are proposed acceptance criteria, not evidence of live enforcement. Begin a candidate rollout in an explicitly selected simulation mode and require an evidence-based decision before enforcement; Microsoft documents using [DLP simulation](https://learn.microsoft.com/en-us/purview/dlp-simulation-mode-get-started) to evaluate impact. Simulation evidence and read-back do not prove every SOP requirement is enforceable.

A future `purview_elicit_requirements` tool could implement the interview using MRTR while returning only draft intent. Its continuation must bind to the verified caller/client, tenant, source/intent version and question set. Longer assessments need an explicit draft ID and protected storage to resume across separate calls; do not assume protocol session state persists. Business documents are evidence, not instructions to execute tools. An approved interpretation should not disappear into an opaque prompt: retain its provenance, revisions and unresolved gaps so policy owners can review changes when the SOP changes.
