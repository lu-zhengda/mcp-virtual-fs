import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VirtualFS, VfsError } from "../../src/vfs.js";
import { PostgresBackend } from "../../src/storage/postgres.js";
import { getTestBackend, releaseContainer } from "../helpers/pg-container.js";

let backend: PostgresBackend;
let vfs: VirtualFS;
const SESSION = "test-session-vfs";

beforeAll(async () => {
  backend = await getTestBackend();
  vfs = new VirtualFS(backend);
});

afterAll(async () => {
  await backend.close();
  await releaseContainer();
});

describe("write + read", () => {
  it("writes and reads back a file", async () => {
    await vfs.write(SESSION, "/hello.txt", "Hello, world!");
    const content = await vfs.read(SESSION, "/hello.txt");
    expect(content).toBe("Hello, world!");
  });

  it("overwrites existing file content", async () => {
    await vfs.write(SESSION, "/overwrite.txt", "v1");
    await vfs.write(SESSION, "/overwrite.txt", "v2");
    expect(await vfs.read(SESSION, "/overwrite.txt")).toBe("v2");
  });

  it("auto-creates parent directories on write", async () => {
    const result = await vfs.write(SESSION, "/deep/nested/file.txt", "content");
    expect(result.created_parents).toBe(true);
    const entries = await vfs.ls(SESSION, "/deep");
    expect(entries).toEqual([{ name: "nested", type: "directory" }]);
  });

  it("returns created_parents: false for root-level files", async () => {
    const result = await vfs.write(SESSION, "/root-file.txt", "content");
    expect(result.created_parents).toBe(false);
  });

  it("reads empty string for file written with empty content", async () => {
    await vfs.write(SESSION, "/empty.txt", "");
    expect(await vfs.read(SESSION, "/empty.txt")).toBe("");
  });

  it("throws ENOENT when reading non-existent file", async () => {
    await expect(vfs.read(SESSION, "/nope.txt")).rejects.toThrow(VfsError);
    try {
      await vfs.read(SESSION, "/nope.txt");
    } catch (e) {
      expect((e as VfsError).code).toBe("ENOENT");
    }
  });

  it("throws EISDIR when reading a directory", async () => {
    await vfs.mkdir(SESSION, "/adir");
    try {
      await vfs.read(SESSION, "/adir");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EISDIR");
    }
  });

  it("throws EISDIR when writing to an existing directory path", async () => {
    await vfs.mkdir(SESSION, "/writedir");
    try {
      await vfs.write(SESSION, "/writedir", "content");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EISDIR");
    }
  });

  it("throws EINVAL when writing to root", async () => {
    try {
      await vfs.write(SESSION, "/", "content");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EINVAL");
    }
  });
});

describe("append", () => {
  const S = "test-session-append";

  it("creates a new file when appending to non-existent path", async () => {
    await vfs.append(S, "/new-append.txt", "first");
    expect(await vfs.read(S, "/new-append.txt")).toBe("first");
  });

  it("appends to existing file content", async () => {
    await vfs.write(S, "/log.txt", "line1\n");
    await vfs.append(S, "/log.txt", "line2\n");
    await vfs.append(S, "/log.txt", "line3\n");
    expect(await vfs.read(S, "/log.txt")).toBe("line1\nline2\nline3\n");
  });

  it("auto-creates parent directories", async () => {
    await vfs.append(S, "/deep/nested/append.txt", "content");
    expect(await vfs.read(S, "/deep/nested/append.txt")).toBe("content");
  });

  it("throws EISDIR when appending to a directory", async () => {
    await vfs.mkdir(S, "/appenddir");
    try {
      await vfs.append(S, "/appenddir", "data");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EISDIR");
    }
  });

  it("throws EINVAL when appending to root", async () => {
    try {
      await vfs.append(S, "/", "data");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EINVAL");
    }
  });
});

describe("stat", () => {
  const S = "test-session-stat";

  it("returns exists: false for non-existent path", async () => {
    const result = await vfs.stat(S, "/nothing-here");
    expect(result).toEqual({ exists: false });
  });

  it("returns file metadata with size", async () => {
    await vfs.write(S, "/file.txt", "hello");
    const result = await vfs.stat(S, "/file.txt");
    expect(result).toEqual({ exists: true, type: "file", size: 5 });
  });

  it("returns directory metadata with children count", async () => {
    await vfs.write(S, "/dir/a.txt", "a");
    await vfs.write(S, "/dir/b.txt", "b");
    await vfs.mkdir(S, "/dir/sub");
    const result = await vfs.stat(S, "/dir");
    expect(result.exists).toBe(true);
    expect(result.type).toBe("directory");
    expect(result.children).toBe(3);
  });
});

describe("ls", () => {
  const S = "test-session-ls";

  it("lists root directory (initially empty or with root)", async () => {
    const entries = await vfs.ls(S, "/");
    // Root exists, may be empty
    expect(Array.isArray(entries)).toBe(true);
  });

  it("lists files and directories sorted dirs-first", async () => {
    await vfs.write(S, "/src/index.ts", "code");
    await vfs.write(S, "/src/util.ts", "util");
    await vfs.mkdir(S, "/src/lib");

    const entries = await vfs.ls(S, "/src");
    expect(entries).toEqual([
      { name: "lib", type: "directory" },
      { name: "index.ts", type: "file" },
      { name: "util.ts", type: "file" },
    ]);
  });

  it("throws ENOENT for non-existent directory", async () => {
    try {
      await vfs.ls(S, "/nonexistent");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("ENOENT");
    }
  });

  it("throws ENOTDIR for a file path", async () => {
    await vfs.write(S, "/afile.txt", "content");
    try {
      await vfs.ls(S, "/afile.txt");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("ENOTDIR");
    }
  });
});

describe("mkdir", () => {
  const S = "test-session-mkdir";

  it("creates a directory", async () => {
    const result = await vfs.mkdir(S, "/newdir");
    expect(result.already_existed).toBe(false);
    const entries = await vfs.ls(S, "/");
    expect(entries.some((e) => e.name === "newdir" && e.type === "directory")).toBe(true);
  });

  it("creates nested directories (mkdir -p)", async () => {
    await vfs.mkdir(S, "/a/b/c");
    const entries = await vfs.ls(S, "/a/b");
    expect(entries).toEqual([{ name: "c", type: "directory" }]);
  });

  it("is idempotent for existing directory and returns already_existed", async () => {
    await vfs.mkdir(S, "/idem");
    const result = await vfs.mkdir(S, "/idem");
    expect(result.already_existed).toBe(true);
    const entries = await vfs.ls(S, "/");
    expect(entries.filter((e) => e.name === "idem")).toHaveLength(1);
  });

  it("is no-op for root", async () => {
    const result = await vfs.mkdir(S, "/");
    expect(result.already_existed).toBe(true);
  });

  it("throws EEXIST if a file exists at the path", async () => {
    await vfs.write(S, "/file-here", "content");
    try {
      await vfs.mkdir(S, "/file-here");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EEXIST");
    }
  });
});

describe("rm", () => {
  const S = "test-session-rm";

  it("removes a file", async () => {
    await vfs.write(S, "/todelete.txt", "bye");
    const count = await vfs.rm(S, "/todelete.txt");
    expect(count).toBe(1);

    await expect(vfs.read(S, "/todelete.txt")).rejects.toThrow();
  });

  it("removes a directory recursively", async () => {
    await vfs.write(S, "/dir/a.txt", "a");
    await vfs.write(S, "/dir/b.txt", "b");
    await vfs.write(S, "/dir/sub/c.txt", "c");

    const count = await vfs.rm(S, "/dir");
    // Should remove: /dir, /dir/a.txt, /dir/b.txt, /dir/sub, /dir/sub/c.txt
    expect(count).toBeGreaterThanOrEqual(4);
  });

  it("throws ENOENT for non-existent path", async () => {
    try {
      await vfs.rm(S, "/ghost");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("ENOENT");
    }
  });

  it("throws EINVAL when trying to remove root", async () => {
    try {
      await vfs.rm(S, "/");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EINVAL");
    }
  });
});

describe("move", () => {
  const S = "test-session-move";

  it("renames a file", async () => {
    await vfs.write(S, "/old.txt", "content");
    await vfs.move(S, "/old.txt", "/new.txt");

    expect(await vfs.read(S, "/new.txt")).toBe("content");
    await expect(vfs.read(S, "/old.txt")).rejects.toThrow(VfsError);
  });

  it("moves a file to a different directory", async () => {
    await vfs.write(S, "/src/file.txt", "data");
    await vfs.move(S, "/src/file.txt", "/dest/file.txt");

    expect(await vfs.read(S, "/dest/file.txt")).toBe("data");
    await expect(vfs.read(S, "/src/file.txt")).rejects.toThrow(VfsError);
  });

  it("moves a directory and all descendants", async () => {
    await vfs.write(S, "/movedir/a.txt", "a");
    await vfs.write(S, "/movedir/sub/b.txt", "b");
    await vfs.move(S, "/movedir", "/moved");

    expect(await vfs.read(S, "/moved/a.txt")).toBe("a");
    expect(await vfs.read(S, "/moved/sub/b.txt")).toBe("b");
    await expect(vfs.ls(S, "/movedir")).rejects.toThrow(VfsError);
  });

  it("auto-creates destination parents", async () => {
    await vfs.write(S, "/src2/file.txt", "data");
    await vfs.move(S, "/src2/file.txt", "/deep/nested/dir/file.txt");
    expect(await vfs.read(S, "/deep/nested/dir/file.txt")).toBe("data");
  });

  it("throws ENOENT when source doesn't exist", async () => {
    try {
      await vfs.move(S, "/ghost", "/target");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("ENOENT");
    }
  });

  it("throws EEXIST when destination already exists", async () => {
    await vfs.write(S, "/exists-src.txt", "src");
    await vfs.write(S, "/exists-dest.txt", "dest");
    try {
      await vfs.move(S, "/exists-src.txt", "/exists-dest.txt");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EEXIST");
    }
  });

  it("throws EINVAL when moving root", async () => {
    try {
      await vfs.move(S, "/", "/newroot");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EINVAL");
    }
  });

  it("throws EINVAL when moving into self", async () => {
    await vfs.mkdir(S, "/selfmove");
    try {
      await vfs.move(S, "/selfmove", "/selfmove/inside");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EINVAL");
    }
  });
});

describe("glob", () => {
  const S = "test-session-glob";

  it("matches files by glob pattern", async () => {
    await vfs.write(S, "/src/index.ts", "code");
    await vfs.write(S, "/src/util.ts", "util");
    await vfs.write(S, "/src/lib/helper.ts", "help");
    await vfs.write(S, "/readme.md", "# Readme");

    const tsFiles = await vfs.glob(S, "**/*.ts");
    expect(tsFiles).toContain("/src/index.ts");
    expect(tsFiles).toContain("/src/util.ts");
    expect(tsFiles).toContain("/src/lib/helper.ts");
    expect(tsFiles).not.toContain("/readme.md");
  });

  it("matches specific directory pattern", async () => {
    const libFiles = await vfs.glob(S, "/src/lib/**");
    expect(libFiles).toContain("/src/lib/helper.ts");
    expect(libFiles).not.toContain("/src/index.ts");
  });

  it("returns empty array when no matches", async () => {
    const matches = await vfs.glob(S, "**/*.xyz");
    expect(matches).toEqual([]);
  });
});

describe("grep", () => {
  const S = "test-session-grep";

  it("finds matching lines in files", async () => {
    await vfs.write(
      S,
      "/src/main.ts",
      'const greeting = "hello";\nconsole.log(greeting);\n',
    );
    await vfs.write(S, "/src/util.ts", "export function hello() {}\n");

    const matches = await vfs.grep(S, "hello");
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.some((m) => m.path === "/src/main.ts" && m.lineNumber === 1)).toBe(true);
    expect(matches.some((m) => m.path === "/src/util.ts")).toBe(true);
  });

  it("supports regex patterns", async () => {
    await vfs.write(S, "/data.txt", "foo123\nbar456\nfoo789\n");

    const matches = await vfs.grep(S, "foo\\d+");
    expect(matches.length).toBe(2);
    expect(matches[0].line).toBe("foo123");
    expect(matches[1].line).toBe("foo789");
  });

  it("supports path filter", async () => {
    const matches = await vfs.grep(S, "hello", "/src/main*");
    expect(matches.every((m) => m.path.startsWith("/src/main"))).toBe(true);
  });

  it("returns empty for no matches", async () => {
    const matches = await vfs.grep(S, "zzzznonexistent");
    expect(matches).toEqual([]);
  });

  it("throws EINVAL for invalid regex patterns", async () => {
    try {
      await vfs.grep(S, "[invalid");
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as VfsError).code).toBe("EINVAL");
    }
  });
});

describe("listStores", () => {
  it("returns list of persistent stores", async () => {
    // Ensure at least one store exists
    await vfs.write("any-session", "/test.txt", "data", "list-test-store");
    const stores = await vfs.listStores();
    expect(stores).toContain("list-test-store");
  });
});
