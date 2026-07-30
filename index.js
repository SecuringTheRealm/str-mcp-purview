#!/usr/bin/env node
// str-mcp-purview — local MCP server for Microsoft Purview data security,
// served over stdio. The tool surface lives in src/server.js so the same
// server can also be hosted per-request over streamable HTTP (functions/).
//
// Developed by Securing the Realm (https://securing.quest/):
//   Chris Lloyd-Jones (Sealjay) & Josh McDonald (KnowledgeRatio).
// Licensed under MIT — this attribution notice must be retained (see LICENCE).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./src/server.js";

await createServer().connect(new StdioServerTransport());
