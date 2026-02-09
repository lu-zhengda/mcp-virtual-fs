#!/usr/bin/env node
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBackend } from "./storage/index.js";
import { VirtualFS } from "./vfs.js";
import { registerTools } from "./tools.js";
import type { PostgresBackend } from "./storage/postgres.js";

async function main() {
  const backend = createBackend();

  // Auto-initialize schema if VFS_AUTO_INIT=true
  if (process.env.VFS_AUTO_INIT === "true") {
    const pg = backend as PostgresBackend;
    if (typeof pg.initSchema === "function") {
      await pg.initSchema({
        withRls: process.env.VFS_ENABLE_RLS === "true",
      });
      console.error("[vfs] Schema initialized successfully");
    }
  }

  // Session ID resolution:
  //   1. Transport-provided sessionId (extra.sessionId in tool callbacks — for HTTP/SSE)
  //   2. VFS_SESSION_ID env var (for deterministic/resumable sessions)
  //   3. Auto-generated UUID (default for stdio — each process = unique session)
  const fallbackSessionId = process.env.VFS_SESSION_ID ?? crypto.randomUUID();
  console.error(`[vfs] Session: ${fallbackSessionId}`);

  const vfs = new VirtualFS(backend);

  const server = new McpServer({
    name: "mcp-virtual-fs",
    version: "1.0.0",
  });

  registerTools(server, vfs, fallbackSessionId);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await backend.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
