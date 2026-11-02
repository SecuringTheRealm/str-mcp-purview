# str-mcp-purview

MCP server for Microsoft Purview data security: sensitivity labels, label policies, auto-labelling and DLP. Node 20+, ESM, no build step. Setup and tool reference: [README.md](README.md) and [docs/](docs/).

## Map

| Path | Role |
|---|---|
| `index.js` | stdio entry: `serveStdio(createServer)` |
| `functions/server.js` | Stateless streamable HTTP host (Azure Functions custom handler) |
| `src/server.js` | `createServer()`: tools, prompts, resources for one connection |
| `src/capabilities/` | Capability catalogue (`definitions.js` schemas, `registry.js`, domain handlers) |
| `src/mcp/projection.js` | Projects the catalogue as `full` (37), `compact` (8) or `dispatcher` (3) tools |
| `src/powershell.js` | One long-lived `pwsh` child running Security & Compliance cmdlets |
| `src/graph.js` | Graph beta reads (label policy settings only) |
| `src/dlp.js`, `src/labels.js`, `src/auto-labels.js` | Tool args to cmdlet params, plus formatters |
| `scripts/` | Live-tenant UAT; creates disposable `ZZZ_MCP_*` objects. Never run without being asked |

## Commands

```bash
npm test                      # node:test; needs --experimental-test-module-mocks (in the script)
npm run benchmark:retrieval   # run after changing capability metadata or search
```

Smoke tests in `test/powershell.smoke.test.js` drive a real `pwsh` and skip without one; set `PURVIEW_PWSH` to point at it.

## Invariants

- **`createServer()` must return a fresh instance per call.** stdio probes with `server/discover` and falls back to `initialize`; HTTP builds one per request. A shared instance breaks the era fallback.
- **stdout is the MCP channel on stdio.** Log to stderr only.
- **`wrapScript()` ends with a blank line, and no script may contain one.** `pwsh -Command -` only runs a piped multi-line block at a blank line. Lose it and every call hangs; add one mid-script and the frame splits.
- **Cmdlet parameters travel as base64 JSON** (`cmdletScript()`), never interpolated into script text. Cmdlet names and `Select-Object` lists must be constants.
- **Bridge errors are never auth-retried.** A timed-out write may already have applied. Only `notStarted` errors and named auth rejections reconnect and retry, once.
- **Deletes always go through form elicitation** (`src/mcp/deletion-confirmation.js`). `confirm: true` must never skip it, and a client without form support must fail closed.
- **Security & Compliance PowerShell is Windows-only.** On other platforms the bridge refuses unless `PURVIEW_ALLOW_UNSUPPORTED_OS=1`. Tests set it.
- **New capabilities go through `defineCapability` + `registry.js`**, never a hand-registered MCP tool. Steps: [docs/design.md](docs/design.md#extending-and-evaluating-the-capability-catalogue).
- **Graph paths are relative**, so the bearer token only reaches `graph.microsoft.com`.

## Tests

Test behaviour that can break: cmdlet parameter mapping, validation, safety gates, protocol eras. Do not add tests for formatted text output, or that only check which cmdlet was called. A regression test must fail on the old code.

## Branching and releases

- Start feature work from `dev` and merge it back by PR. `main` only receives releases from `dev`, merged with a **merge commit** and tagged at that merge commit. Never squash `dev` into `main`; the `release-source` workflow rejects other sources.
- Before merging to `dev`, run **ponytail**, **junior-to-senior** and **last-20-percent**. The latter two live in `.agents/skills/`; ponytail is [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail).
- Delete merged feature branches. Leave branches with unmerged work alone.

## Working in this repo

- **This repository is public.** No tenant domains, object IDs, tenant user names or UAT output in files, commits, issues or pasted snippets; use `contoso.onmicrosoft.com` or `<tenant>.onmicrosoft.com`. `artifacts/` (UAT reports) is gitignored for this reason.
- **Stage explicitly; never `git add -A`.** That is how UAT reports with tenant identifiers reached a commit (#71).
- **One worktree per session and feature** (`git worktree add`, or `claude --worktree <name>`). Two sessions in one checkout move HEAD under each other and put commits on the wrong branch.
- `.githooks/pre-commit` catches the commonest slips: staged gitignored files and real `*.onmicrosoft.com` domains (not GUIDs or UPNs, so still check). `npm install` turns it on (`prepare`); otherwise run `git config core.hooksPath .githooks` once per clone. CI's `public-data` job repeats the domain check.
- `.claude/skills/` entries are symlinks; on Windows set `git config core.symlinks true` before cloning for Claude Code to see them.

## Conventions

Use conventional commits, British English in prose and American English in code. Bump `package.json` by the lowest semver step; `serverInfo.version` reads it. Update vendored skills from their sources: product-owner, user-story and `.codex/` from Agent OS; junior-to-senior and last-20-percent from `Sealjay/dotfiles`. `.claude/skills/` links to `.agents/skills/`.
