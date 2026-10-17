#!/usr/bin/env node
// str-mcp-purview — local MCP server for Microsoft Purview data security,
// served over stdio. The tool surface lives in src/server.js so the same
// server can also be hosted per-request over streamable HTTP (functions/).
//
// Developed by Securing the Realm (https://securing.quest/):
//   Chris Lloyd-Jones (Sealjay) & Josh McDonald (KnowledgeRatio).
// Licensed under MIT — this attribution notice must be retained (see LICENCE).

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./src/server.js";
import { bridgesIdle } from "./src/powershell.js";

// Build one server now, so a bad setting stops startup with its message
// instead of failing every connection with "Internal server error".
createServer({ transport: "stdio" });
// When the client goes away, finish what it already asked for, then exit: a live
// pwsh child would otherwise keep this process (and its signed-in session)
// running. Exiting closes the child's stdin, which ends it.
process.stdin.once("end", function exitWhenIdle() {
  setTimeout(() => (bridgesIdle() ? process.exit(0) : exitWhenIdle()), 100);
});
await serveStdio((context) => createServer({ ...context, transport: "stdio" }));
