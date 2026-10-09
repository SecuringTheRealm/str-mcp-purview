# GitHub reflection and verification

## Mapping

GitHub Issues are the source of truth for live records. Use native sub-issues for Epic → Story → Task and native blocking dependencies for directed dependency edges. Native issue types, when available, may supplement labels; labels remain the portable representation. Milestones capture release goals. Projects are optional views with explicitly mapped fields, not a prerequisite for an accurate issue backlog.

Use the labels defined in [backlog-model.md](backlog-model.md). Keep one primary `type:*` and, once triaged, one `priority:*`. Base delivery status is exclusive; `status:blocked` is additive. Bug severity and risk lifecycle have their own namespaces. Preserve unrelated labels. Retain conventional `bug` or `enhancement` labels when useful. If a repository uses equivalent conventions, record an explicit mapping and reconcile against it rather than adding conflicting namespaces.

## Record content

Preserve the destination's established format and human content. Each managed issue should contain:

- A stable, repository-local source key in `<!-- product-owner:key=SOURCE_KEY -->`, where SOURCE_KEY comes from a durable source ID or a chosen key persisted in the migration mapping. Never regenerate it from a mutable title.
- Outcome/problem, source links, scope/exclusions, type-appropriate acceptance criteria, priority and rationale, known ownership or explicit unassigned state, and relevant validation evidence.
- Parent/children and affected-item references for human navigation; native edges are authoritative when supported.
- Dependencies with gate stage and rationale; informational relationships use `Related to`, not `Blocked by`.
- Required type-specific fields from the backlog model, including bug severity/reproduction, risk assessment/decision, or blocker/unblock condition.

For new records, a concise common skeleton is:

```markdown
<!-- product-owner:key=SOURCE_KEY -->
## Outcome and scope
...
## Acceptance criteria / exit criteria
...
## Priority
P1 — rationale and applicable delivery goal
## Relationships
Parent: OWNER/REPO#123 (if applicable)
Affected work: OWNER/REPO#456 (if applicable)
Blocked by: OWNER/REPO#789 — completion gate; rationale
## Validation and decisions
...
```

Add the type-specific fields without imposing user-story wording on engineering/risk/bug records. Unknown owners, dates, and assessments remain explicit. Preserve existing checkbox states and acceptance text unless authorized changes or verified evidence justify altering them.

## Reconcile safely

1. Confirm target repository, user authorization, issue access and the tools available. Read existing open AND closed issues, labels, milestones, relationships, and relevant project fields with pagination. A read failure is not an empty backlog. Reuse the user's existing scope/authorization.
2. Build a reviewable intended mapping: stable source key → existing/new issue; kind, priority, lifecycle, parent, dependencies, affected work, and acceptance coverage. Detect duplicates and cycles before writing. Preserve existing hierarchy unless restructuring is authorized. Document missing ownership/refinement and capability gaps.
3. Ensure only the required labels/milestones within authorized scope. Do not force-edit existing label semantics or broadly change organization issue types/project fields. Reuse suitable milestones; create goals without invented deadlines. Create parents before children, save issue number, numeric database ID, node ID and URL immediately, then establish relationships in a second pass.
4. Use native endpoints below through `gh api` or equivalent connector tools. Resolve identifiers from actual responses. Never confuse issue number, numeric database ID and GraphQL node ID. Inspect a child's current parent before linking; do not use `replace_parent=true` unless a reparent is authorized. Native sub-issues are one parent per child.
5. Write bodies using structured tool inputs or UTF-8 files and `--body-file`. Patch the intended fields, preserving human content/labels and concurrent updates. Before replacing a body, re-read it and detect conflicting human edits. Check each mutation result; read current state before a retry after ambiguous failure. Do not repeat create calls blindly. Paginate relationship reads and use bounded retries respecting rate limits; after three failed attempts stop that operation, retain completed mappings, and report the exact unresolved change.
6. Read back all touched issue fields, bodies, labels, state/reason, parent/children and blocking edges. Verify source coverage, exclusive types/priorities/statuses, acyclic hierarchy/dependencies, no duplicates, acceptance preservation and correct closure evidence. If project fields were changed, verify those separately. Report native versus fallback relationships and any mismatch; never declare success just because commands returned URLs.

## Native relationship APIs

Current official references: [sub-issues](https://docs.github.com/en/rest/issues/sub-issues), [issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies). Check current documentation for the target GitHub host/version when API capability is uncertain.

For hierarchy, `GET /repos/{owner}/{repo}/issues/{child_number}/parent` reads the parent and `GET /repos/{owner}/{repo}/issues/{parent_number}/sub_issues` lists children. `POST` to the latter adds a child using JSON `sub_issue_id` containing the child's numeric database ID.

For dependencies, `GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by` lists blockers. `POST` to the same endpoint adds a blocker using JSON `issue_id` containing the blocker's numeric database ID. `GET .../dependencies/blocking` verifies the reverse direction.

Use typed integers with `gh api -F sub_issue_id=ID` / `-F issue_id=ID` or structured JSON; these IDs are not `#number`. Permissions and host capability must be established. A 404 can mean no parent, inaccessible content, or unsupported capability; it is not by itself proof of unsupported native relationships. Investigate capability/auth before fallback. Do not write a relationship solely to probe capabilities.

When native relationships are demonstrably unsupported or inaccessible with the current authorized credentials, explicitly distinguish unsupported host capability from denied permission. Do not bypass permissions or claim that a 403 proves GitHub lacks the feature. If body-link updates are authorized and accessible, explicitly record the degraded representation: child body `Parent: OWNER/REPO#N`; parent body child checklist; dependent body `Blocked by: OWNER/REPO#N` plus rationale; blocker body `Blocks: OWNER/REPO#N`. Verify both directions and flag that GitHub native rollups/blocked queries are unavailable. Body links must not be described as native relationships. API/permission errors remain reported gaps even if fallback links were saved.

## Read-only audit helper

For canonical labels and same-repository native relationships, run from the installed product-owner skill directory:

```text
python scripts/audit_github.py OWNER/REPO path/to/manifest.json
```

The manifest is the intended state for the issues being reconciled, not a second live backlog. It can be temporary. Example:

```json
{
  "items": [
    {"number": 10, "kind": "epic", "priority": "P1", "status": "backlog", "parent": null, "blocked_by": []},
    {"number": 11, "kind": "story", "priority": "P1", "status": "ready", "parent": 10, "blocked_by": []},
    {"number": 12, "kind": "task", "priority": "P1", "status": "backlog", "parent": 11, "blocked_by": [13]},
    {"number": 13, "kind": "blocker", "priority": "P0", "status": "in-progress", "parent": null, "blocked_by": []}
  ]
}
```

For risk items use `risk_status` instead of `status`. `blocked` defaults to false and verifies the blocked flag; optional `severity` verifies a bug severity; `priority: null` represents untriaged priority. `parent` and `blocked_by` describe the complete intended relationship sets for each listed record. Omit no existing edge merely because it lies outside the current assignment; incorporate it before reconciliation. A direct epic/task exception requires `parent_exception` in the manifest with its rationale. Dependencies/parents outside this manifest are fetched read-only for graph/type checking.

The helper makes no writes, requires an already authenticated `gh`, reads paginated native relationships, compares labels/state and checks graph cycles. It exits nonzero on drift or read errors. It does not check acceptance meaning, priority rationale, source-key uniqueness across the full repository, ownership, affected-item references, risk acceptance authority, native issue types, project fields, or fallback body links. Verify those separately before claiming a complete reflection.

