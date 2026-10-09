# Roadmap

[GitHub Issues](https://github.com/SecuringTheRealm/str-mcp-purview/issues) are the source of truth for delivery status, acceptance, priority and dependencies. This page is navigation; update issues rather than maintaining a second status list.

## Delivery outcomes

| Outcome | GitHub epic | Initial priority rationale |
| --- | --- | --- |
| Validate safe delivery of the expanded MCP surface | [#22](https://github.com/SecuringTheRealm/str-mcp-purview/issues/22) | P0 - Mandatory before the affected deployment/release claim |
| Complete verified label and DLP control coverage | [#27](https://github.com/SecuringTheRealm/str-mcp-purview/issues/27) | P1 - Important extension of established protection/classification scope |
| Author and inspect reusable classification primitives | [#38](https://github.com/SecuringTheRealm/str-mcp-purview/issues/38) | P1 - Important extension of established protection/classification scope |
| Extend protection to verified enterprise AI surfaces | [#48](https://github.com/SecuringTheRealm/str-mcp-purview/issues/48) | P2 - Deferrable new capability or feasibility discovery |
| Establish a coherent retention-label and policy solution | [#53](https://github.com/SecuringTheRealm/str-mcp-purview/issues/53) | P2 - Deferrable new capability or feasibility discovery |
| Resolve feasibility of additional Purview planes | [#57](https://github.com/SecuringTheRealm/str-mcp-purview/issues/57) | P2 - Deferrable new capability or feasibility discovery |

## What exists and what remains unverified

The branch has 37 canonical capabilities, two prompts and three resources. Full, compact and dispatcher projections expose 37, eight and three tools respectively. Label/DLP configuration CRUD, Endpoint/Copilot phase-one controls, authoritative label reads and ten core automatic-label policy/rule operations are implemented; see [README](README.md) for their contracts and limitations.

Implementation is not the same as deployed acceptance. Copilot label formatting and DLP setter confirmation fixes passed selected live tests through the local PowerShell bridge. Deployed HTTP/proxy execution, the supported authentication matrix, automatic-label simulation/status/activation and the timeout-recovery live retest remain release work. Advanced automatic-label parameters currently fail explicitly where mappings are unverified.

Broad stories stay in backlog/refinement until split into verified, testable slices. Parameter additions belong on existing operations when they configure the same object; distinct objects and new connection planes are scoped separately.

## Feasibility and prioritization

- A documented surface on an existing plane is usually a parameter-mapping candidate; verify workload, permissions and actual readback.
- XML/JSON builders, new auth scopes and multi-call orchestration require explicit validation and a coherent object model.
- An unconfirmed surface requires discovery; portal availability is not API evidence. Historical Tier 3 claims are retained as source context rather than asserted as current proof of no API.
- New Insider Risk, Communications Compliance and DSPM planes remain separately scoped discovery work.
- Feasibility tiers do not determine delivery priority or issue lifecycle; P0/P1/P2 rationales and native dependencies live on each issue.

## Traceability and contribution

The migration manages 44 records: six epics, 11 stories and 27 tasks, including the existing [SDK migration #20](https://github.com/SecuringTheRealm/str-mcp-purview/issues/20). Native parent/sub-issue and blocking relationships express structure and completion gates. Shared engineering/discovery tasks have explicit exceptions to the usual Epic -> Story -> Task hierarchy.

Every outstanding original obligation maps through [source coverage](docs/backlog/coverage.md). The [original roadmap](docs/backlog/roadmap-before-migration.md) remains preserved verbatim; [migration provenance and verification](docs/backlog/README.md) describe the workflow and its limits. These are migration records, not a second tracker.

When proposing work, include the user outcome, documented command/API or discovery question, workload/auth constraints and observable acceptance criteria. Preserve existing source keys, human acceptance text and release gates when refining issues. No owner, date, estimate or API support claim should be inferred.
