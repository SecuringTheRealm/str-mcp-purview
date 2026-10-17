---
name: user-story
description: Create or refine development-ready user stories using Mike Cohn's persona/action/outcome format and Gherkin acceptance criteria. Use for user needs, product requirements, and backlog refinement; keep pure refactoring and technical debt as engineering tasks.
metadata:
  source: "User-supplied user-story.skill; adapted from deanpeters/product-manager-prompts"
---

# User stories

Translate a user need into a concise conversation starter that identifies who benefits, what they do, why it matters, and how success is verified. Follow the user's requested format and preserve existing requirements when refining work.

## Establish the context

Identify the specific persona or role, the problem, desired outcome, and relevant constraints from the supplied material and current product context. Use an actual person's name only when provided and relevant. State meaningful assumptions. Ask a focused question when missing context prevents an accurate story; do not invent personas, validated research, metrics, deadlines, or scope. Discovery interviews are optional work, not a prerequisite for every story.

## Write the story

Use [template.md](template.md) when a complete artifact is useful. Scale its sections to the task and the destination's established issue format.

- Give the story a short title that describes user value.
- **As a** specific persona or role, **I want to** take an action, **so that** I achieve a meaningful outcome.
- Make the outcome explain the motivation rather than repeat the action. Avoid generic "as a user" when a more precise role is known.
- Keep implementation design in constraints or engineering notes when it affects delivery, rather than disguising a technical task as user value.

## Define testable acceptance

Write named scenarios using Given/When/Then:

```gherkin
Scenario: A trial user accesses the app with an existing identity
  Given a trial user is on the login page
  And the user has a supported identity provider account
  When the user signs in through that provider
  Then the user reaches onboarding with an authenticated session
```

Give each scenario one triggering action and one primary observable outcome. Add preconditions with `And`. Additional observable assertions for the same outcome may use `And`; separate independent triggers or distinct user outcomes into scenarios or stories. Align `When` with the story's action and `Then` with its outcome.

Cover relevant success, failure, permission, and boundary cases. Make outcomes concrete enough for QA to verify. Use numeric targets only when provided or explicitly agreed. When editing an existing issue, retain its acceptance obligations, traceability, security constraints, and release gates; Gherkin clarifies them rather than silently replacing or weakening them. Preserve checklist state unless evidence justifies changing it.

## Check readiness and split scope

Apply INVEST: Independent, Negotiable, Valuable, Estimable, Small, Testable. Treat stories as prompts for product/engineering discussion rather than immutable contracts.

Split broad feature lists or independent user outcomes into small, valuable slices. Keep necessary security and failure handling with the behavior they protect. Identify real dependencies; do not claim independence where it does not exist. For an epic or roadmap item, propose child stories while preserving the parent requirements and links.

Reject vague outcomes such as "better experience" or "faster" without an observable condition. Keep pure refactoring, platform enablement, and technical debt as engineering tasks with objective acceptance criteria rather than fabricated "as a developer" stories.

Check that a reviewer can explain who/what/why and derive a test for each scenario. Report unresolved assumptions or readiness gaps proportionally to the task.

## Source and adaptation

Adapted from the user's `user-story.skill`, which attributes its source to `prompts/user-story-prompt-template.md` in https://github.com/deanpeters/product-manager-prompts and draws on Mike Cohn, Gherkin, and INVEST. The uploaded archive contains only its SKILL.md. This Codex adaptation provides its own template and does not require the absent persona, problem-statement, story-splitting, epic, example, or script files. Its single-trigger guidance permits supporting assertions for the same observable outcome.

