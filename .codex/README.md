# Repository product owner

The `product_owner` agent is registered in [config.toml](config.toml) and defined
in [agents/product_owner.toml](agents/product_owner.toml).

Imported from `KnowledgeRatio/codex-agent-os` at commit
`66f3d0eb9af8ba196a58f76ee98be149d1d5ec98` on 8 October 2026. The definition
and its bundled dependencies were copied without rewriting their instructions:

- `.agents/skills/product-owner/`: backlog model, GitHub reconciliation workflow
  and read-only native relationship audit.
- `.agents/skills/user-story/`: user-story guidance and acceptance template.

Request the product owner for requirements, roadmap or backlog work. GitHub
writes require authorization in the task; installing the agent does not grant
permission to change external records. GitHub issues hold live delivery status;
the repository roadmap and migration mapping provide navigation and traceability.

These are project-local copies. Update them deliberately from Agent OS rather
than assuming they follow subsequent changes in that repository automatically.
