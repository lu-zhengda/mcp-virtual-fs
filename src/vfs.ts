import picomatch from "picomatch";
import type { StorageBackend, GrepMatch } from "./storage/index.js";
import { validatePath, ancestorPaths, basename, parentPath } from "./paths.js";

/** Filesystem error with a POSIX-style error code. */
export class VfsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VfsError";
  }
}

export interface LsEntry {
  name: string;
  type: "file" | "directory";
}

export interface StatResult {
  exists: boolean;
  type?: "file" | "directory";
  size?: number;
  children?: number;
}

/**
 * Virtual filesystem with POSIX-like semantics.
 * Stateless w.r.t. session — each method takes sessionId as a parameter.
 * Sessions are auto-provisioned on first use.
 */
const MAX_GLOB_PATHS = 10_000;

export class VirtualFS {
  constructor(private backend: StorageBackend) {}

  private ns(sessionId: string, store?: string): Promise<string> {
    return this.backend.resolveNamespace(sessionId, store);
  }

  private async ensureParents(
    namespaceId: string,
    path: string,
  ): Promise<void> {
    for (const ancestor of ancestorPaths(path)) {
      await this.backend.insertDir(namespaceId, ancestor);
    }
  }

  // ── Operations ─────────────────────────────────────────────

  async stat(sessionId: string, path: string, store?: string): Promise<StatResult> {
    const p = validatePath(path);
    const nsId = await this.ns(sessionId, store);
    const node = await this.backend.getNode(nsId, p);

    if (!node) {
      return { exists: false };
    }

    if (node.nodeType === "file") {
      return {
        exists: true,
        type: "file",
        size: (node.content ?? "").length,
      };
    }

    const children = await this.backend.countChildren(nsId, p);
    return {
      exists: true,
      type: "directory",
      children,
    };
  }

  async read(sessionId: string, path: string, store?: string): Promise<string> {
    const p = validatePath(path);
    const nsId = await this.ns(sessionId, store);
    const node = await this.backend.getNode(nsId, p);

    if (!node) {
      throw new VfsError("ENOENT", `No such file: ${p}`);
    }
    if (node.nodeType === "directory") {
      throw new VfsError("EISDIR", `Is a directory: ${p}`);
    }
    return node.content ?? "";
  }

  async write(
    sessionId: string,
    path: string,
    content: string,
    store?: string,
  ): Promise<{ created_parents: boolean }> {
    const p = validatePath(path);
    if (p === "/") {
      throw new VfsError("EINVAL", "Cannot write to root directory");
    }

    const nsId = await this.ns(sessionId, store);

    const existing = await this.backend.getNode(nsId, p);
    if (existing?.nodeType === "directory") {
      throw new VfsError("EISDIR", `Is a directory: ${p}`);
    }

    const ancestors = ancestorPaths(p);
    const createdParents = ancestors.length > 1;
    await this.ensureParents(nsId, p);
    await this.backend.upsertFile(nsId, p, content);
    return { created_parents: createdParents };
  }

  async append(
    sessionId: string,
    path: string,
    content: string,
    store?: string,
  ): Promise<void> {
    const p = validatePath(path);
    if (p === "/") {
      throw new VfsError("EINVAL", "Cannot append to root directory");
    }

    const nsId = await this.ns(sessionId, store);

    const existing = await this.backend.getNode(nsId, p);
    if (existing?.nodeType === "directory") {
      throw new VfsError("EISDIR", `Is a directory: ${p}`);
    }

    await this.ensureParents(nsId, p);
    await this.backend.appendFile(nsId, p, content);
  }

  async ls(sessionId: string, path: string, store?: string): Promise<LsEntry[]> {
    const p = validatePath(path);
    const nsId = await this.ns(sessionId, store);
    const node = await this.backend.getNode(nsId, p);

    if (!node) {
      throw new VfsError("ENOENT", `No such directory: ${p}`);
    }
    if (node.nodeType !== "directory") {
      throw new VfsError("ENOTDIR", `Not a directory: ${p}`);
    }

    const children = await this.backend.listChildren(nsId, p);

    return children
      .map((c) => ({ name: basename(c.path), type: c.nodeType }))
      .sort((a, b) => {
        if (a.type !== b.type) {
          return a.type === "directory" ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
  }

  async mkdir(
    sessionId: string,
    path: string,
    store?: string,
  ): Promise<{ already_existed: boolean }> {
    const p = validatePath(path);
    if (p === "/") return { already_existed: true };

    const nsId = await this.ns(sessionId, store);

    const existing = await this.backend.getNode(nsId, p);
    if (existing?.nodeType === "file") {
      throw new VfsError("EEXIST", `File exists at path: ${p}`);
    }

    const alreadyExisted = existing?.nodeType === "directory";
    await this.ensureParents(nsId, p);
    await this.backend.insertDir(nsId, p);
    return { already_existed: alreadyExisted };
  }

  async rm(sessionId: string, path: string, store?: string): Promise<number> {
    const p = validatePath(path);
    if (p === "/") {
      throw new VfsError("EINVAL", "Cannot remove root directory");
    }

    const nsId = await this.ns(sessionId, store);
    const node = await this.backend.getNode(nsId, p);

    if (!node) {
      throw new VfsError("ENOENT", `No such file or directory: ${p}`);
    }

    return this.backend.deleteNode(nsId, p);
  }

  async move(
    sessionId: string,
    source: string,
    destination: string,
    store?: string,
  ): Promise<void> {
    const src = validatePath(source);
    const dest = validatePath(destination);

    if (src === "/") {
      throw new VfsError("EINVAL", "Cannot move root directory");
    }
    if (dest === "/") {
      throw new VfsError("EINVAL", "Cannot move to root directory");
    }
    if (dest.startsWith(src + "/")) {
      throw new VfsError("EINVAL", "Cannot move a directory into itself");
    }

    const nsId = await this.ns(sessionId, store);

    const srcNode = await this.backend.getNode(nsId, src);
    if (!srcNode) {
      throw new VfsError("ENOENT", `No such file or directory: ${src}`);
    }

    const destNode = await this.backend.getNode(nsId, dest);
    if (destNode) {
      throw new VfsError("EEXIST", `Destination already exists: ${dest}`);
    }

    const destParent = parentPath(dest);
    if (destParent !== "/") {
      await this.ensureParents(nsId, dest);
    }

    await this.backend.moveNode(nsId, src, dest);
  }

  async glob(sessionId: string, pattern: string, store?: string): Promise<string[]> {
    const nsId = await this.ns(sessionId, store);
    const allPaths = await this.backend.allFilePaths(nsId);
    if (allPaths.length > MAX_GLOB_PATHS) {
      throw new VfsError(
        "EINVAL",
        `Too many files (${allPaths.length}) to glob — maximum is ${MAX_GLOB_PATHS}. Use grep with path_filter to narrow your search.`,
      );
    }
    const isMatch = picomatch(pattern);
    return allPaths.filter((p) => isMatch(p));
  }

  async grep(
    sessionId: string,
    pattern: string,
    pathFilter?: string,
    store?: string,
  ): Promise<GrepMatch[]> {
    // Validate the regex pattern before sending to PostgreSQL.
    // This gives a clear error message for invalid patterns instead of
    // a raw SQL error, and acts as a basic sanity check.
    try {
      new RegExp(pattern);
    } catch {
      throw new VfsError("EINVAL", `Invalid regex pattern: ${pattern}`);
    }

    const nsId = await this.ns(sessionId, store);

    let sqlPathFilter: string | undefined;
    if (pathFilter) {
      // Escape SQL LIKE metacharacters before converting glob wildcards
      const escaped = pathFilter.replace(/%/g, "\\%").replace(/_/g, "\\_");
      sqlPathFilter = escaped.replace(/\*\*/g, "%").replace(/\*/g, "%");
    }

    return this.backend.grepContent(nsId, pattern, sqlPathFilter);
  }

  async listStores(): Promise<string[]> {
    return this.backend.listStores();
  }
}
