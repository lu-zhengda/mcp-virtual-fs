import { describe, it, expect } from "vitest";
import {
  normalizePath,
  parentPath,
  basename,
  ancestorPaths,
  validatePath,
  PathError,
} from "../../src/paths.js";

describe("normalizePath", () => {
  it("returns / for empty input", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("returns / for root", () => {
    expect(normalizePath("/")).toBe("/");
  });

  it("ensures leading slash", () => {
    expect(normalizePath("a/b")).toBe("/a/b");
  });

  it("strips trailing slash", () => {
    expect(normalizePath("/a/b/")).toBe("/a/b");
  });

  it("resolves . segments", () => {
    expect(normalizePath("/a/./b")).toBe("/a/b");
  });

  it("resolves .. segments", () => {
    expect(normalizePath("/a/b/../c")).toBe("/a/c");
  });

  it("resolves .. at root stays at root", () => {
    expect(normalizePath("/a/../../b")).toBe("/b");
  });

  it("collapses multiple slashes", () => {
    expect(normalizePath("/a//b///c")).toBe("/a/b/c");
  });

  it("handles complex path", () => {
    expect(normalizePath("/a/b/../c/./d/../e")).toBe("/a/c/e");
  });
});

describe("parentPath", () => {
  it("returns / for root", () => {
    expect(parentPath("/")).toBe("/");
  });

  it("returns / for top-level path", () => {
    expect(parentPath("/a")).toBe("/");
  });

  it("returns parent for nested path", () => {
    expect(parentPath("/a/b/c")).toBe("/a/b");
  });

  it("normalizes before computing parent", () => {
    expect(parentPath("a/b")).toBe("/a");
  });
});

describe("basename", () => {
  it("returns / for root", () => {
    expect(basename("/")).toBe("/");
  });

  it("returns filename from path", () => {
    expect(basename("/a/b/c.ts")).toBe("c.ts");
  });

  it("returns single segment", () => {
    expect(basename("/foo")).toBe("foo");
  });
});

describe("ancestorPaths", () => {
  it("returns empty array for root", () => {
    expect(ancestorPaths("/")).toEqual([]);
  });

  it("returns [/] for top-level path", () => {
    expect(ancestorPaths("/a")).toEqual(["/"]);
  });

  it("returns all ancestors for deep path", () => {
    expect(ancestorPaths("/a/b/c")).toEqual(["/", "/a", "/a/b"]);
  });

  it("normalizes input", () => {
    expect(ancestorPaths("a/b/c")).toEqual(["/", "/a", "/a/b"]);
  });
});

describe("validatePath", () => {
  it("returns normalized path for valid input", () => {
    expect(validatePath("/a/b")).toBe("/a/b");
  });

  it("normalizes and returns valid paths", () => {
    expect(validatePath("a/b/../c")).toBe("/a/c");
  });

  it("throws on null bytes", () => {
    expect(() => validatePath("/a\0b")).toThrow(PathError);
  });

  it("throws on control characters", () => {
    expect(() => validatePath("/a\x01b")).toThrow(PathError);
  });

  it("throws on excessively long paths", () => {
    const long = "/" + "a".repeat(4096);
    expect(() => validatePath(long)).toThrow(PathError);
  });

  it("accepts paths at the length limit", () => {
    const p = "/" + "a".repeat(4095);
    expect(validatePath(p)).toBe(p);
  });

  it("throws on paths exceeding max depth (50 levels)", () => {
    const deep = "/" + Array.from({ length: 51 }, (_, i) => `d${i}`).join("/");
    expect(() => validatePath(deep)).toThrow(PathError);
    expect(() => validatePath(deep)).toThrow("depth");
  });

  it("accepts paths at the depth limit (50 levels)", () => {
    const atLimit = "/" + Array.from({ length: 50 }, (_, i) => `d${i}`).join("/");
    expect(validatePath(atLimit)).toBe(atLimit);
  });
});
