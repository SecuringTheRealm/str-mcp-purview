---
name: product-owner
description: Manage product requirements and delivery backlogs with epic/story/task hierarchy, P0/P1/P2 priorities, dependencies, risks, blockers, and bugs. Use for product ownership, backlog refinement, roadmap migration, and GitHub delivery tracking.
---

# Product owner

Turn product intent into prioritized, reviewable delivery work grounded in current requirements, implementation, and user needs. Keep the user's scope and existing acceptance obligations authoritative.

## Working model

Read [references/backlog-model.md](references/backlog-model.md) when shaping, prioritizing, or reviewing a backlog. It defines epic → story → task hierarchy, priority, lifecycle, dependencies, risk, blocker, and bug records.

Read and apply the bundled [user-story skill](../user-story/SKILL.md) for user-facing stories: persona/action/outcome, Given/When/Then scenarios, INVEST checks, and valuable slices. Preserve engineering work as tasks with objective criteria. Do not fabricate personas or force risks and bugs into story format.

Establish the source of truth from requirements, roadmap, current issues, and implementation evidence. Separate verified completion, partial implementation, active work, and unstarted scope. Mock content, attractive UI, and historical implementation status do not prove delivery readiness.

## GitHub reflection

Before creating or updating GitHub records, read [references/github-workflow.md](references/github-workflow.md). Use native sub-issues for hierarchy and native blocking dependencies where available; represent type, priority, and lifecycle with the defined labels or an explicit mapping to existing repository conventions. Milestones represent delivery goals, not parent issues or dependency edges.

Preserve source traceability, acceptance criteria, security constraints, and release gates. Identify true dependencies and permit independent work where appropriate. Do not invent owners, estimates, dates, research, severity, or progress. Record unknown values explicitly and surface material readiness gaps.

Apply a read-plan-reconcile-verify workflow. Reuse existing issues, keep stable source keys, and re-read records and relationships after mutations. Preserve human edits and report partial failures. Never claim a native hierarchy or dependency was installed based only on body links.

For a canonical same-repository backlog, run [scripts/audit_github.py](scripts/audit_github.py) against the intended manifest to verify issue metadata and native relationships. The GitHub reference documents its scope and manifest format. Use explicit manual readback for custom label mappings, cross-repository relationships, body-link fallback, and record content; the helper does not validate those.

## Delivery and authority

Update external trackers only within the user's existing authorization. A skill invocation alone does not authorize publishing records, sending messages, or changing unrelated settings. Do not reorganize a live backlog merely because this global workflow was installed.

Use evidence for status transitions. Completing child tasks does not automatically satisfy story acceptance; closing stories does not automatically meet epic exit criteria. Validate bug fixes, blocker removal, and risk decisions separately. Keep GitHub authoritative for live status, with local indexes updated when requested.

Summarize concrete results, unresolved decisions, readiness gaps, and the next useful delivery slice, with issue/artifact links and verification limits. Scale the process to the task rather than imposing a fixed story count or unnecessary ceremony.

