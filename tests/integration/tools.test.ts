import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { VirtualFS } from "../../src/vfs.js";
import { PostgresBackend } from "../../src/storage/postgres.js";
import { registerTools } from "../../src/tools.js";
import { getTestBackend, releaseContainer } from "../helpers/pg-container.js";

let backend: PostgresBackend;
let client: Client;
let mcpServer: McpServer;

const FALLBACK_SESSION = "mcp-e2e-session";

beforeAll(async () => {
  backend = await getTestBackend();
  const vfs = new VirtualFS(backend);

  mcpServer = new McpServer({ name: "test-vfs", version: "0.0.1" });
  registerTools(mcpServer, vfs, FALLBACK_SESSION);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.1" });

  await mcpServer.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await mcpServer.close();
  await backend.close();
  await releaseContainer();
});

/** Helper to call a tool and parse the JSON response. */
async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ data: unknown; isError?: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  const text = content[0].text;

  // Error responses are plain text, not JSON
  if (result.isError) {
    return { data: text, isError: true };
  }

  return { data: JSON.parse(text), isError: false };
}

describe("MCP tool e2e via in-memory transport", () => {
  it("lists all 11 tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("write");
    expect(names).toContain("append");
    expect(names).toContain("stat");
    expect(names).toContain("ls");
    expect(names).toContain("mkdir");
    expect(names).toContain("rm");
    expect(names).toContain("move");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
    expect(names).toContain("list_stores");
    expect(tools).toHaveLength(11);
  });

  it("tool schemas do not include session_id", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as { properties?: Record<string, unknown> };
      expect(schema.properties).not.toHaveProperty("session_id");
    }
  });

  it("mkdir + ls returns structured JSON", async () => {
    const mkResult = await callTool("mkdir", { path: "/project" });
    expect(mkResult.data).toEqual({
      path: "/project",
      already_existed: false,
    });

    const lsResult = await callTool("ls", { path: "/" });
    const lsData = lsResult.data as { entries: Array<{ name: string; type: string }> };
    expect(lsData.entries.some((e) => e.name === "project")).toBe(true);
  });

  it("write + read returns structured JSON", async () => {
    const writeResult = await callTool("write", {
      path: "/project/hello.ts",
      content: 'export const msg = "hello";',
    });
    const writeData = writeResult.data as { path: string; size: number; created_parents: boolean };
    expect(writeData.path).toBe("/project/hello.ts");
    expect(writeData.size).toBe(27);

    const readResult = await callTool("read", { path: "/project/hello.ts" });
    const readData = readResult.data as { content: string; size: number };
    expect(readData.content).toBe('export const msg = "hello";');
    expect(readData.size).toBe(27);
  });

  it("stat returns file metadata", async () => {
    const result = await callTool("stat", { path: "/project/hello.ts" });
    expect(result.data).toEqual({
      exists: true,
      type: "file",
      size: 27,
    });
  });

  it("stat returns directory metadata", async () => {
    const result = await callTool("stat", { path: "/project" });
    const data = result.data as { exists: boolean; type: string; children: number };
    expect(data.exists).toBe(true);
    expect(data.type).toBe("directory");
    expect(data.children).toBeGreaterThanOrEqual(1);
  });

  it("stat returns {exists: false} for missing path", async () => {
    const result = await callTool("stat", { path: "/nonexistent/path" });
    expect(result.data).toEqual({ exists: false });
  });

  it("append creates and appends to files", async () => {
    await callTool("append", { path: "/project/log.txt", content: "line1\n" });
    await callTool("append", { path: "/project/log.txt", content: "line2\n" });

    const readResult = await callTool("read", { path: "/project/log.txt" });
    const readData = readResult.data as { content: string };
    expect(readData.content).toBe("line1\nline2\n");
  });

  it("ls shows files and directories", async () => {
    await callTool("write", { path: "/project/src/index.ts", content: "main" });

    const result = await callTool("ls", { path: "/project" });
    const data = result.data as { entries: Array<{ name: string; type: string }> };
    expect(data.entries.some((e) => e.name === "src" && e.type === "directory")).toBe(true);
    expect(data.entries.some((e) => e.name === "hello.ts" && e.type === "file")).toBe(true);
  });

  it("glob finds files by pattern", async () => {
    const result = await callTool("glob", { pattern: "**/*.ts" });
    const data = result.data as { files: string[]; count: number };
    expect(data.files).toContain("/project/hello.ts");
    expect(data.files).toContain("/project/src/index.ts");
    expect(data.count).toBeGreaterThanOrEqual(2);
  });

  it("grep finds content matches", async () => {
    const result = await callTool("grep", { pattern: "hello" });
    const data = result.data as { matches: Array<{ path: string; lineNumber: number; line: string }>; count: number };
    expect(data.matches.some((m) => m.path === "/project/hello.ts")).toBe(true);
    expect(data.count).toBeGreaterThanOrEqual(1);
  });

  it("move renames files", async () => {
    await callTool("write", { path: "/project/old.txt", content: "moveme" });
    const moveResult = await callTool("move", {
      source: "/project/old.txt",
      destination: "/project/new.txt",
    });
    expect(moveResult.data).toEqual({
      source: "/project/old.txt",
      destination: "/project/new.txt",
    });

    const readResult = await callTool("read", { path: "/project/new.txt" });
    expect((readResult.data as { content: string }).content).toBe("moveme");

    // Original path should not exist
    const oldResult = await callTool("read", { path: "/project/old.txt" });
    expect(oldResult.isError).toBe(true);
  });

  it("rm removes files and returns count", async () => {
    const result = await callTool("rm", { path: "/project/new.txt" });
    const data = result.data as { path: string; deleted: number };
    expect(data.path).toBe("/project/new.txt");
    expect(data.deleted).toBe(1);

    const readResult = await callTool("read", { path: "/project/new.txt" });
    expect(readResult.isError).toBe(true);
    expect(readResult.data).toContain("ENOENT");
  });

  it("rm recursively removes directories", async () => {
    const result = await callTool("rm", { path: "/project" });
    expect(result.isError).toBeFalsy();

    const lsResult = await callTool("ls", { path: "/project" });
    expect(lsResult.isError).toBe(true);
    expect(lsResult.data).toContain("ENOENT");
  });

  it("store parameter enables cross-session access", async () => {
    await callTool("write", {
      path: "/memory.md",
      content: "Remember this",
      store: "mcp-shared",
    });

    const result = await callTool("read", {
      path: "/memory.md",
      store: "mcp-shared",
    });
    expect((result.data as { content: string }).content).toBe("Remember this");
  });

  it("store data is separate from session data", async () => {
    await callTool("write", { path: "/data.txt", content: "session-only" });
    await callTool("write", {
      path: "/data.txt",
      content: "store-only",
      store: "mcp-shared",
    });

    const sessionRead = await callTool("read", { path: "/data.txt" });
    expect((sessionRead.data as { content: string }).content).toBe("session-only");

    const storeRead = await callTool("read", { path: "/data.txt", store: "mcp-shared" });
    expect((storeRead.data as { content: string }).content).toBe("store-only");
  });

  it("list_stores returns store names", async () => {
    const result = await callTool("list_stores");
    const data = result.data as { stores: string[]; count: number };
    expect(data.stores).toContain("mcp-shared");
    expect(data.count).toBeGreaterThanOrEqual(1);
  });

  it("error responses have isError flag", async () => {
    const result = await callTool("read", { path: "/nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.data).toContain("ENOENT");
  });

  it("ls on empty directory returns empty entries array", async () => {
    await callTool("mkdir", { path: "/empty" });
    const result = await callTool("ls", { path: "/empty" });
    const data = result.data as { entries: unknown[] };
    expect(data.entries).toEqual([]);
  });

  it("grep with path_filter", async () => {
    await callTool("write", { path: "/src/app.ts", content: "const x = 42;" });
    await callTool("write", { path: "/docs/guide.md", content: "const y = 42;" });

    const result = await callTool("grep", {
      pattern: "42",
      path_filter: "/src/**",
    });
    const data = result.data as { matches: Array<{ path: string }> };
    expect(data.matches.some((m) => m.path === "/src/app.ts")).toBe(true);
    expect(data.matches.some((m) => m.path === "/docs/guide.md")).toBe(false);
  });
});
