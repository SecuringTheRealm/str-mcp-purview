# Roadmap migration record

GitHub Issues are authoritative for live delivery status, priority and relationships. The files here record the migration and its source coverage; they are not a parallel tracker.

- [Original roadmap](roadmap-before-migration.md): preserved verbatim, including historical implementation and feasibility assertions. Those assertions have not all been re-certified by this migration.
- [Intended mapping](migration-plan.json): stable `roadmap-v1.*` keys, source obligations, scope, acceptance criteria and intended hierarchy.
- [GitHub identifiers](migration-records.json): issue numbers, numeric IDs, node IDs and URLs saved during reconciliation.
- [Verification manifest](migration-manifest.json): intended labels, state, parents and blocking relationships for the imported product-owner audit helper.
- [Source provenance](migration-provenance.json): preserved source hash and expected graph counts.
- [Verification result](migration-verification.json): the canonical graph audit and direct/independent content readback passed for all 44 records, including 38 native parent edges and three native blocking edges.
- [Migration reconciler](migrate_roadmap.py): `python docs/backlog/migrate_roadmap.py` produces the plan without network writes; `--apply` performs the explicitly authorized migration. Re-running the write path is not routine status maintenance: it reapplies the migration's initial labels and bodies, so subsequent human changes must be reconciled first.

The migration uses native GitHub sub-issues and blocking relationships, with portable `type:*`, `priority:P0/P1/P2` and `status:*` labels. Existing unrelated issues, labels and human acceptance text are preserved. No milestone, owner, estimate or date was invented.

The six outcome epics cover release validation, label/DLP extensions, classification/reporting, enterprise AI, retention and feasibility discovery. User-facing stories use persona/action/outcome and Gherkin; shared engineering and discovery tasks sit directly under their epic with explicit exceptions. Broad backlog stories are refinement containers and must be split into verified implementation slices before being marked ready.

Release P0 work is mandatory before the affected deployment claim, not a declaration of an active incident. P1 covers important extensions of the established scope; P2 covers deferrable capabilities. A feasibility tier is not a priority or delivery status. A missing verified API is a discovery question, not an invented external blocker.

Implemented auto-label core remains distinct from advanced reserved parameters and live validation. The Copilot label and DLP setter fixes passed selected local live tests, but deployed HTTP verification and the timeout-recovery live retest remain open. Raw tenant/object identifiers from local test evidence are intentionally excluded from public issue bodies.

Audit with the repository-local imported workflow:

```text
python .agents/skills/product-owner/scripts/audit_github.py SecuringTheRealm/str-mcp-purview docs/backlog/migration-manifest.json
```

The helper verifies labels, state and native relationship graphs; source coverage, acceptance preservation, issue content and unrelated-record preservation require separate readback. Migration source links to branch files become available on GitHub only after these local files are committed and pushed; this task does not commit or push.
