/** Represents a file or directory node in the virtual filesystem. */
export interface VfsNode {
  path: string;
  nodeType: "file" | "directory";
  content: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A single grep match: one line in one file. */
export interface GrepMatch {
  path: string;
  lineNumber: number;
  line: string;
}

/**
 * Storage backend interface for the virtual filesystem.
 *
 * VFS depends only on this interface — never on a concrete backend.
 * Each method operates within a single namespace (session or store).
 */
export interface StorageBackend {
  // ── Lifecycle ──────────────────────────────────────────────

  /** Gracefully close connections. */
  close(): Promise<void>;

  // ── Session / store management ─────────────────────────────

  /** Ensure an ephemeral session namespace exists (with root dir). */
  ensureSession(id: string): Promise<void>;

  /** Ensure a persistent named store exists (with root dir). */
  ensureStore(name: string): Promise<void>;

  /**
   * Resolve the target namespace ID.
   * - If `store` is provided, ensures the store exists and returns its name.
   * - Otherwise ensures the session exists and returns sessionId.
   * Auto-provisions sessions/stores on first use.
   */
  resolveNamespace(sessionId: string, store?: string): Promise<string>;

  /** List all persistent store names. */
  listStores(): Promise<string[]>;

  // ── Node operations ────────────────────────────────────────

  /** Get a single node by exact path. Returns null if not found. */
  getNode(namespaceId: string, path: string): Promise<VfsNode | null>;

  /** Count immediate children of a directory. */
  countChildren(namespaceId: string, dirPath: string): Promise<number>;

  /** List immediate children of a directory. */
  listChildren(namespaceId: string, dirPath: string): Promise<VfsNode[]>;

  /** Insert or update a file node. */
  upsertFile(namespaceId: string, path: string, content: string): Promise<void>;

  /** Append content to a file. Creates the file if it doesn't exist. */
  appendFile(namespaceId: string, path: string, content: string): Promise<void>;

  /** Insert a directory node (idempotent — ON CONFLICT DO NOTHING). */
  insertDir(namespaceId: string, path: string): Promise<void>;

  /** Delete a node and all descendants. Returns the number of deleted rows. */
  deleteNode(namespaceId: string, path: string): Promise<number>;

  /** Move/rename a node and all descendants. */
  moveNode(
    namespaceId: string,
    sourcePath: string,
    destPath: string,
  ): Promise<void>;

  // ── Search ─────────────────────────────────────────────────

  /** Return all file paths in a namespace (for in-app glob matching). */
  allFilePaths(namespaceId: string): Promise<string[]>;

  /** Regex grep across file contents. Returns matching lines. */
  grepContent(
    namespaceId: string,
    pattern: string,
    pathFilter?: string,
  ): Promise<GrepMatch[]>;
}
