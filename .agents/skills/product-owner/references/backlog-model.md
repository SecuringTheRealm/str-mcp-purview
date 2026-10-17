# Backlog model

## Hierarchy and issue types

Default delivery hierarchy: **Epic → Story → Task**. Each record is a separate GitHub issue with one primary type label: `type:epic`, `type:story`, `type:task`, `type:bug`, `type:risk`, or `type:blocker`.

| Type | Purpose | Required substance |
| --- | --- | --- |
| Epic | A substantial product outcome delivered by several stories | Problem, target users/outcome, scope and exclusions, measurable exit criteria, child stories, release gates |
| Story | One valuable, independently reviewable user behavior | Specific persona/action/outcome, Gherkin acceptance scenarios, constraints, parent epic, validation |
| Task | Implementation, research, test, or operational work supporting delivery | Concrete output, rationale, objective acceptance/validation, parent story |
| Bug | Observed deviation from expected behavior | Expected/actual behavior, reproduction, environment/version, evidence, impact, severity, regression validation |
| Risk | An uncertain future event that could affect delivery or operation | Cause/event/consequence, likelihood, impact, exposure, mitigation, trigger/contingency, accountable owner and review point |
| Blocker | A present impediment preventing a specific next step | Current impediment and evidence, affected work/stage, unblock condition, responsible party, next action, escalation/review point |

Give each story one epic parent and each task one story parent. A record can affect several items but has at most one structural parent. Use affected-item links for additional associations. Keep each hierarchy acyclic. Bugs may be children of the relevant story when they contribute to its delivery; risks and blockers usually link to affected work rather than masquerading as child stories.

Allow a task directly under an epic for shared engineering enablement that has no honest user-story boundary, with the exception explained. A standalone operational task or bug may remain outside the hierarchy while its product relationship is clarified. Report missing parents for planned stories/tasks as refinement gaps; do not manufacture epics or stories just to fill levels. A leaf task is a work unit; small checklists inside it are not additional hidden hierarchy.

Decompose scope when useful and requested, retaining every original acceptance obligation and mapping it to children or parent exit criteria. Do not discard a requirement because it is difficult to assign. Parent/child structure means containment, not blocking dependency. Child priority need not match its parent; justify deviations and ensure parent delivery does not conceal a required P0 item.

## Priority definitions

Assign exactly one of `priority:P0`, `priority:P1`, or `priority:P2` to each triaged record. Record the rationale and applicable delivery gate in its body. An item with insufficient information is explicitly untriaged, with the missing decision recorded; do not infer its priority from its title.

| Priority | Definition | Scheduling rule |
| --- | --- | --- |
| P0 | Mandatory before the affected release/use, or urgent remediation of unacceptable current impact: critical security/data-integrity exposure, service failure, or a non-negotiable release requirement | Must resolve before the affected gate can pass; active incidents require immediate triage. P0 does not itself invent an incident or a deadline. |
| P1 | Important committed outcome or significant impairment with tolerable short-term impact/workaround | Plan for the next agreed delivery goal after relevant P0 obligations; a due date requires an actual agreement. |
| P2 | Valuable improvement, optimization, or future capability that can be deferred without breaching current gates | Prioritize by value, effort, and dependencies as capacity permits; optional does not mean never. |

In Foundry Posture, the existing roadmap maps P0 to production-data readiness, P1 to private-beta completeness, and P2 to scale/operations/enterprise scope. These are product-specific delivery goals, not universal definitions for every repository. Broader P2 infrastructure work never demotes a control required for a P0 gate.

Priority is delivery urgency; severity is observed impact; risk exposure combines probability and consequence. They are separate fields. Reassess priority when impact, evidence, deadlines, workarounds, or gate requirements change. Do not auto-promote every dependency or all descendants to the highest priority.

## Lifecycle and completion

For delivery work (epics, stories, tasks, bugs, blockers), keep one base status: `status:backlog`, `status:ready`, `status:in-progress`, `status:in-review`, `status:done`, or `status:cancelled`.

- Backlog: recorded, unstarted, refinement may be incomplete.
- Ready: clear scope and testable criteria; necessary decisions for the next step are made.
- In progress: evidence of active work; an assignment alone is insufficient.
- In review: delivery exists and awaits acceptance or validation.
- Done: acceptance and required validation are evidenced; GitHub state is closed with reason `completed`.
- Cancelled: explicit scope decision, with rationale; GitHub state is closed with reason `not_planned`. Record duplicates and superseding issues, without claiming delivery.

All other base statuses imply an open GitHub issue. `status:blocked` is an additional flag, not a replacement for the base status. Add it only when a present impediment prevents the next relevant step. An unresolved completion dependency alone does not mean independent work cannot proceed. Remove it when unblock evidence is verified, while preserving the correct base status.

For an epic, complete all required children and exit criteria. For a story, demonstrate acceptance scenarios and gates, even if all tasks are closed. For a task, demonstrate its specified output/validation. Closing records never constitutes validation evidence. When reopening delivery work, remove stale done/cancelled labels, restore an evidence-supported base status, and recheck affected ancestors and dependents.

## Dependencies and blockers

Use **A blocked by B** to mean B must be resolved before A can complete the specified stage or release. Write the dependency rationale and whether it gates start, integration, completion, or release. Keep dependency graphs acyclic; distinguish informational `Related to` links from hard dependencies.

A blocker record represents a present nontrivial impediment, including external approvals/access or missing decisions. If an existing issue already accurately represents the impediment, link it instead of creating a duplicate blocker. Link each affected issue to the blocking issue and describe the unblock condition. Escalation targets and dates must be provided or agreed; flag missing ownership rather than inventing it. Resolve a blocker only when the unblock condition is demonstrated; re-evaluate the blocked flags on affected issues.

## Risk management

Use likelihood Low/Medium/High and impact Low/Medium/High, with evidence and uncertainty stated. Suggested exposure: High when impact is High and likelihood Medium/High, or likelihood High and impact Medium; Low when both are Low; Medium otherwise. Domain-specific scales may replace this mapping when documented. Priority still requires its own rationale.

Keep one `risk:open`, `risk:mitigating`, `risk:accepted`, or `risk:resolved` label. Risk records stay open for open, mitigating, and accepted exposure. `risk:resolved` requires demonstrated mitigation/removal and closed/completed state. A retired/out-of-scope risk closes as not-planned with decision rationale and `risk:retired`. Do not give risk records delivery base-status labels; linked mitigation tasks use the delivery lifecycle.

Acceptance requires an authorized decision-maker, decision evidence, rationale, residual exposure, and review/expiry condition. The agent does not accept risk on the user's behalf. Represent mitigation work as linked tasks/stories. If the event occurs, link or create the actual bug/blocker/incident record and reassess the risk; avoid losing the history or silently renaming the uncertain event as resolved.

## Bug triage

Use exactly one severity label once assessed:

| Severity | Meaning |
| --- | --- |
| `severity:critical` | Severe loss of availability, unauthorized exposure, data loss/corruption, or comparable impact requiring urgent assessment |
| `severity:high` | Core behavior is materially broken, with no acceptable workaround for affected users |
| `severity:medium` | Meaningful impairment with a viable workaround or limited scope |
| `severity:low` | Minor/cosmetic impairment with little effect on completing the user outcome |

Record affected users/scope, frequency and workaround to justify severity. Keep reproduction and verification safe; sanitize secrets and sensitive evidence. Unknown/unreproduced impact remains explicit rather than assigned an invented severity. A bug needs a separate P0/P1/P2 decision based on impact and delivery context. Link affected story/epic, dependencies, fix PR, regression proof, and relevant release. Do not close just because a fix merged if required validation remains outstanding.

