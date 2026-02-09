import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VirtualFS, VfsError } from "../../src/vfs.js";
import { PostgresBackend } from "../../src/storage/postgres.js";
import { getTestBackend, releaseContainer } from "../helpers/pg-container.js";

let backend: PostgresBackend;
let vfs: VirtualFS;

beforeAll(async () => {
  backend = await getTestBackend();
  vfs = new VirtualFS(backend);
});

afterAll(async () => {
  await backend.close();
  await releaseContainer();
});

describe("session isolation", () => {
  it("sessions cannot see each other's files", async () => {
    await vfs.write("session-A", "/secret.txt", "A's data");
    await vfs.write("session-B", "/secret.txt", "B's data");

    expect(await vfs.read("session-A", "/secret.txt")).toBe("A's data");
    expect(await vfs.read("session-B", "/secret.txt")).toBe("B's data");
  });

  it("deleting in one session does not affect another", async () => {
    await vfs.write("iso-A", "/file.txt", "A");
    await vfs.write("iso-B", "/file.txt", "B");

    await vfs.rm("iso-A", "/file.txt");

    await expect(vfs.read("iso-A", "/file.txt")).rejects.toThrow(VfsError);
    expect(await vfs.read("iso-B", "/file.txt")).toBe("B");
  });

  it("ls in one session only shows its own files", async () => {
    await vfs.write("ls-A", "/a.txt", "a");
    await vfs.write("ls-B", "/b.txt", "b");

    const entriesA = await vfs.ls("ls-A", "/");
    const entriesB = await vfs.ls("ls-B", "/");

    expect(entriesA.some((e) => e.name === "a.txt")).toBe(true);
    expect(entriesA.some((e) => e.name === "b.txt")).toBe(false);
    expect(entriesB.some((e) => e.name === "b.txt")).toBe(true);
    expect(entriesB.some((e) => e.name === "a.txt")).toBe(false);
  });

  it("glob in one session only matches its own files", async () => {
    await vfs.write("glob-A", "/file.ts", "a");
    await vfs.write("glob-B", "/file.ts", "b");
    await vfs.write("glob-B", "/other.ts", "c");

    const matchesA = await vfs.glob("glob-A", "**/*.ts");
    expect(matchesA).toEqual(["/file.ts"]);

    const matchesB = await vfs.glob("glob-B", "**/*.ts");
    expect(matchesB).toHaveLength(2);
  });

  it("grep in one session only searches its own files", async () => {
    await vfs.write("grep-A", "/data.txt", "findme-A");
    await vfs.write("grep-B", "/data.txt", "findme-B");

    const matchesA = await vfs.grep("grep-A", "findme");
    expect(matchesA).toHaveLength(1);
    expect(matchesA[0].line).toBe("findme-A");

    const matchesB = await vfs.grep("grep-B", "findme");
    expect(matchesB).toHaveLength(1);
    expect(matchesB[0].line).toBe("findme-B");
  });
});

describe("persistent stores (cross-session)", () => {
  const STORE = "shared-memory";

  it("session A writes to a store, session B reads it", async () => {
    await vfs.write("writer-session", "/notes/context.md", "shared data", STORE);
    const content = await vfs.read("reader-session", "/notes/context.md", STORE);
    expect(content).toBe("shared data");
  });

  it("store data is separate from session data", async () => {
    await vfs.write("my-session", "/file.txt", "session-only");
    await vfs.write("my-session", "/file.txt", "store-only", STORE);

    expect(await vfs.read("my-session", "/file.txt")).toBe("session-only");
    expect(await vfs.read("my-session", "/file.txt", STORE)).toBe("store-only");
  });

  it("ls works on stores from any session", async () => {
    await vfs.write("any-session", "/a.txt", "a", STORE);
    await vfs.write("any-session", "/b.txt", "b", STORE);

    const entries = await vfs.ls("different-session", "/", STORE);
    expect(entries.some((e) => e.name === "a.txt")).toBe(true);
    expect(entries.some((e) => e.name === "b.txt")).toBe(true);
  });

  it("glob works on stores from any session", async () => {
    await vfs.write("s1", "/src/app.ts", "code", "code-store");
    await vfs.write("s1", "/src/util.ts", "util", "code-store");

    const matches = await vfs.glob("s2", "**/*.ts", "code-store");
    expect(matches).toContain("/src/app.ts");
    expect(matches).toContain("/src/util.ts");
  });

  it("grep works on stores from any session", async () => {
    await vfs.write("s1", "/log.txt", "ERROR: something failed\nINFO: ok\n", "log-store");

    const matches = await vfs.grep("s2", "ERROR", undefined, "log-store");
    expect(matches).toHaveLength(1);
    expect(matches[0].line).toContain("ERROR");
  });

  it("rm in a store from any session works", async () => {
    await vfs.write("s1", "/temp.txt", "tmp", "rm-store");
    const count = await vfs.rm("s2", "/temp.txt", "rm-store");
    expect(count).toBe(1);

    await expect(vfs.read("s1", "/temp.txt", "rm-store")).rejects.toThrow(VfsError);
  });

  it("stores are auto-created on first use", async () => {
    // Writing to a store that doesn't exist yet should work
    await vfs.write("s1", "/auto.txt", "auto-created", "auto-store-" + Date.now());
  });
});

describe("session auto-provisioning", () => {
  it("sessions are created automatically on first tool call", async () => {
    const uniqueSession = "auto-provision-" + Date.now();
    await vfs.write(uniqueSession, "/test.txt", "works");
    expect(await vfs.read(uniqueSession, "/test.txt")).toBe("works");
  });

  it("multiple operations on a new session all work", async () => {
    const s = "fresh-session-" + Date.now();
    await vfs.mkdir(s, "/src");
    await vfs.write(s, "/src/index.ts", "hello");
    const entries = await vfs.ls(s, "/src");
    expect(entries).toEqual([{ name: "index.ts", type: "file" }]);
    const content = await vfs.read(s, "/src/index.ts");
    expect(content).toBe("hello");
  });
});
