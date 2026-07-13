# Security Policy

## Supported versions

This project is pre-release and moves quickly. Only the latest commit on `main`
receives security fixes. There is no backporting to older commits or tags.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub: go to the
[Security tab](https://github.com/SecuringTheRealm/str-mcp-purview/security)
and choose **Report a vulnerability**. This opens a private advisory visible
only to you and the maintainers.

Please include:

- what the vulnerability allows an attacker to do,
- the steps or proof of concept needed to reproduce it,
- the affected files, tools, or configuration,
- any suggested fix, if you have one.

You can expect an acknowledgement within 5 working days and an assessment
within 10. If a fix is warranted, we will agree a disclosure timeline with you
and credit you in the published advisory unless you prefer otherwise.

## Scope

This is a Model Context Protocol server that connects an AI agent to Microsoft
Purview using your own tenant credentials. Security issues in this repository
are things this code does wrong, for example:

- leaking credentials, tokens, or tenant data through logs, errors, or tool output,
- injection into the PowerShell or Graph calls this server makes,
- a tool performing a write, publish, or delete that the caller did not ask for,
- broader Entra permissions being requested or used than a tool needs,
- dependency vulnerabilities reachable through this code.

Out of scope: vulnerabilities in Microsoft Purview, Microsoft Graph, or Entra ID
themselves (report those to the
[Microsoft Security Response Centre](https://msrc.microsoft.com/report/vulnerability/new?WT.mc_id=AI-MVP-5004204)),
and issues arising from a deployment that ignores the guidance below.

## Operational guidance

This server acts with the permissions of the identity you give it, and some of
its tools change or delete labels, policies, and DLP configuration. Treat that
as a trust boundary:

- Grant the least-privileged Entra app registration or account that works for
  your use case, and prefer read-only scopes unless you need writes.
- Keep credentials in your local `.env` or MCP client configuration. Never
  commit them. `.env` and `.mcp.json` are gitignored for this reason.
- Review what an agent proposes before approving a destructive tool call.
