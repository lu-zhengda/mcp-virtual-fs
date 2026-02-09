import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VirtualFS, VfsError } from "./vfs.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

const storeParam = z
  .string()
  .optional()
  .describe(
    "Named persistent store for cross-session access. Omit to use the session's own namespace.",
  );

/**
 * Resolve the session ID from MCP transport context.
 * Priority: extra.sessionId (transport-provided) > fallbackSessionId (env or auto-generated UUID)
 */
function resolveSession(extra: { sessionId?: string }, fallback: string): string {
  return extra.sessionId ?? fallback;
}

/** Register all VFS tools on the MCP server. */
export function registerTools(
  server: McpServer,
  vfs: VirtualFS,
  fallbackSessionId: string,
): void {
  // ── read ────────────────────────────────────────────────────

  server.tool(
    "read",
    "Read the contents of a file. Returns the file content and size in bytes. " +
      "Errors: ENOENT if the file does not exist, EISDIR if the path is a directory.",
    {
      path: z.string().describe("Absolute path to the file (e.g. /src/index.ts)"),
      store: storeParam,
    },
    { readOnlyHint: true },
    async ({ path, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        const content = await vfs.read(sid, path, store);
        return ok({ content, size: content.length });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── write ───────────────────────────────────────────────────

  server.tool(
    "write",
    "Write content to a file, creating it if it doesn't exist. " +
      "Parent directories are created automatically (like mkdir -p). " +
      "Overwrites existing file content entirely. " +
      "Returns whether parent directories were created. " +
      "Errors: EISDIR if the path is an existing directory, EINVAL if writing to root.",
    {
      path: z.string().describe("Absolute path to the file (e.g. /notes/todo.md)"),
      content: z.string().describe("Full content to write to the file"),
      store: storeParam,
    },
    { idempotentHint: true },
    async ({ path, content, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        const result = await vfs.write(sid, path, content, store);
        return ok({ path, size: content.length, created_parents: result.created_parents });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── append ──────────────────────────────────────────────────

  server.tool(
    "append",
    "Append content to the end of a file. Creates the file if it doesn't exist. " +
      "Parent directories are created automatically. " +
      "Useful for logs or incrementally building files. " +
      "Errors: EISDIR if the path is an existing directory, EINVAL if appending to root.",
    {
      path: z.string().describe("Absolute path to the file to append to"),
      content: z.string().describe("Content to append to the end of the file"),
      store: storeParam,
    },
    async ({ path, content, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        await vfs.append(sid, path, content, store);
        return ok({ path, appended_bytes: content.length });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── stat ────────────────────────────────────────────────────

  server.tool(
    "stat",
    "Check whether a path exists and get metadata about it. " +
      "Returns exists (boolean), and if it exists: type (file or directory), " +
      "size (bytes, for files), or children count (for directories). " +
      "Never errors — returns {exists: false} for missing paths.",
    {
      path: z.string().describe("Absolute path to check"),
      store: storeParam,
    },
    { readOnlyHint: true },
    async ({ path, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        const result = await vfs.stat(sid, path, store);
        return ok(result);
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── ls ──────────────────────────────────────────────────────

  server.tool(
    "ls",
    "List the contents of a directory. Returns an array of entries, each with " +
      "a name and type (file or directory). Entries are sorted with directories first, " +
      "then alphabetically. " +
      "Errors: ENOENT if the directory does not exist, ENOTDIR if the path is a file.",
    {
      path: z.string().describe("Absolute path to the directory to list (e.g. / or /src)"),
      store: storeParam,
    },
    { readOnlyHint: true },
    async ({ path, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        const entries = await vfs.ls(sid, path, store);
        return ok({ entries });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── mkdir ───────────────────────────────────────────────────

  server.tool(
    "mkdir",
    "Create a directory and any missing parent directories (mkdir -p behavior). " +
      "Idempotent — succeeds even if the directory already exists. " +
      "Returns whether the directory already existed. " +
      "Errors: EEXIST if a file (not directory) already exists at the path.",
    {
      path: z.string().describe("Absolute path of the directory to create (e.g. /src/utils)"),
      store: storeParam,
    },
    { idempotentHint: true },
    async ({ path, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        const result = await vfs.mkdir(sid, path, store);
        return ok({ path, already_existed: result.already_existed });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── rm ──────────────────────────────────────────────────────

  server.tool(
    "rm",
    "Remove a file or directory recursively (like rm -rf). " +
      "Returns the total number of nodes deleted (the target plus any descendants). " +
      "Errors: ENOENT if the path does not exist, EINVAL if attempting to remove root.",
    {
      path: z.string().describe("Absolute path to remove"),
      store: storeParam,
    },
    { destructiveHint: true },
    async ({ path, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        const deleted = await vfs.rm(sid, path, store);
        return ok({ path, deleted });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── move ────────────────────────────────────────────────────

  server.tool(
    "move",
    "Move or rename a file or directory. Moves all descendants when moving a directory. " +
      "Parent directories at the destination are created automatically. " +
      "Errors: ENOENT if source doesn't exist, EEXIST if destination already exists, " +
      "EINVAL if moving root or moving a directory into itself.",
    {
      source: z.string().describe("Absolute path of the file or directory to move"),
      destination: z.string().describe("Absolute path of the new location"),
      store: storeParam,
    },
    async ({ source, destination, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        await vfs.move(sid, source, destination, store);
        return ok({ source, destination });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── glob ────────────────────────────────────────────────────

  server.tool(
    "glob",
    "Find files matching a glob pattern. Supports wildcards (*.ts), " +
      "recursive matching (**/*.md), and brace expansion ({py,json}). " +
      "Returns an array of matching file paths. Only matches files, not directories.",
    {
      pattern: z.string().describe("Glob pattern (e.g. **/*.ts, /src/**/*.{js,ts})"),
      store: storeParam,
    },
    { readOnlyHint: true },
    async ({ pattern, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        const files = await vfs.glob(sid, pattern, store);
        return ok({ files, count: files.length });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── grep ────────────────────────────────────────────────────

  server.tool(
    "grep",
    "Search file contents using a regular expression. Returns matching lines with " +
      "file path and line number. Searches are accelerated by a PostgreSQL trigram index. " +
      "Optionally filter which files to search with a path glob.",
    {
      pattern: z
        .string()
        .describe("Regular expression pattern to search for (e.g. TODO|FIXME)"),
      path_filter: z
        .string()
        .optional()
        .describe("Glob pattern to limit which files are searched (e.g. /src/**)"),
      store: storeParam,
    },
    { readOnlyHint: true },
    async ({ pattern, path_filter, store }, extra) => {
      try {
        const sid = resolveSession(extra, fallbackSessionId);
        const matches = await vfs.grep(sid, pattern, path_filter, store);
        return ok({ matches, count: matches.length });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );

  // ── list_stores ─────────────────────────────────────────────

  server.tool(
    "list_stores",
    "List all named persistent stores. Stores are cross-session namespaces " +
      "for long-term data that survives session cleanup. Returns an array of store names.",
    {},
    { readOnlyHint: true },
    async () => {
      try {
        const stores = await vfs.listStores();
        return ok({ stores, count: stores.length });
      } catch (e) {
        if (e instanceof VfsError) return err(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  );
}
