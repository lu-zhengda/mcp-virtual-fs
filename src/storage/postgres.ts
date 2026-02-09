import pg from "pg";
import type { StorageBackend, VfsNode, GrepMatch } from "./interface.js";
import { SCHEMA_SQL, RLS_SQL } from "./schema.js";

const { Pool } = pg;

export interface PostgresBackendOptions {
  connectionString: string;
  enableRls: boolean;
}

export class PostgresBackend implements StorageBackend {
  private pool: pg.Pool;
  private enableRls: boolean;
  /** Cache of already-provisioned namespaces to avoid repeated INSERT on every call. */
  private knownNamespaces = new Set<string>();

  constructor(opts: PostgresBackendOptions) {
    this.pool = new Pool({ connectionString: opts.connectionString });
    this.enableRls = opts.enableRls;
  }

  // ── Lifecycle ──────────────────────────────────────────────

  /** Auto-initialize database schema. Runs CREATE IF NOT EXISTS — safe to call repeatedly. */
  async initSchema(opts?: { withRls?: boolean }): Promise<void> {
    await this.pool.query(SCHEMA_SQL);
    if (opts?.withRls) {
      await this.pool.query(RLS_SQL);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ── Internal: RLS-aware query helper ───────────────────────

  private async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
    namespaceId?: string,
  ): Promise<pg.QueryResult<T>> {
    if (this.enableRls && namespaceId) {
      const client = await this.pool.connect();
      try {
        await client.query("SELECT set_config('app.vfs_session_id', $1, false)", [namespaceId]);
        return await client.query<T>(text, params);
      } finally {
        client.release();
      }
    }
    return this.pool.query<T>(text, params);
  }

  // ── Session / store management ─────────────────────────────

  async ensureSession(id: string): Promise<void> {
    if (this.knownNamespaces.has(id)) return;
    await this.query(
      `INSERT INTO vfs_sessions (id, is_persistent) VALUES ($1, false)
       ON CONFLICT (id) DO NOTHING`,
      [id],
      id,
    );
    await this.insertDir(id, "/");
    this.knownNamespaces.add(id);
  }

  async ensureStore(name: string): Promise<void> {
    if (this.knownNamespaces.has(name)) return;
    await this.query(
      `INSERT INTO vfs_sessions (id, is_persistent) VALUES ($1, true)
       ON CONFLICT (id) DO NOTHING`,
      [name],
      name,
    );
    await this.insertDir(name, "/");
    this.knownNamespaces.add(name);
  }

  async resolveNamespace(sessionId: string, store?: string): Promise<string> {
    if (store) {
      await this.ensureStore(store);
      return store;
    }
    await this.ensureSession(sessionId);
    return sessionId;
  }

  async listStores(): Promise<string[]> {
    const { rows } = await this.query<{ id: string }>(
      `SELECT id FROM vfs_sessions WHERE is_persistent = true ORDER BY id`,
    );
    return rows.map((r) => r.id);
  }

  // ── Node operations ────────────────────────────────────────

  async getNode(namespaceId: string, path: string): Promise<VfsNode | null> {
    const { rows } = await this.query<{
      path: string;
      node_type: "file" | "directory";
      content: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT path, node_type, content, created_at, updated_at
       FROM vfs_nodes WHERE session_id = $1 AND path = $2`,
      [namespaceId, path],
      namespaceId,
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      path: r.path,
      nodeType: r.node_type,
      content: r.content,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  async countChildren(namespaceId: string, dirPath: string): Promise<number> {
    const prefix = dirPath === "/" ? "/" : dirPath + "/";
    const { rows } = await this.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM vfs_nodes
       WHERE session_id = $1
         AND path LIKE $2 || '%'
         AND path NOT LIKE $2 || '%/%'
         AND path != $3`,
      [namespaceId, prefix, dirPath],
      namespaceId,
    );
    return parseInt(rows[0].count, 10);
  }

  async listChildren(namespaceId: string, dirPath: string): Promise<VfsNode[]> {
    const prefix = dirPath === "/" ? "/" : dirPath + "/";

    const { rows } = await this.query<{
      path: string;
      node_type: "file" | "directory";
      content: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT path, node_type, content, created_at, updated_at
       FROM vfs_nodes
       WHERE session_id = $1
         AND path LIKE $2 || '%'
         AND path NOT LIKE $2 || '%/%'
         AND path != $3`,
      [namespaceId, prefix, dirPath],
      namespaceId,
    );

    return rows.map((r) => ({
      path: r.path,
      nodeType: r.node_type,
      content: r.content,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  async upsertFile(
    namespaceId: string,
    path: string,
    content: string,
  ): Promise<void> {
    await this.query(
      `INSERT INTO vfs_nodes (session_id, path, node_type, content)
       VALUES ($1, $2, 'file', $3)
       ON CONFLICT (session_id, path)
       DO UPDATE SET content = EXCLUDED.content, updated_at = now()`,
      [namespaceId, path, content],
      namespaceId,
    );
  }

  async appendFile(
    namespaceId: string,
    path: string,
    content: string,
  ): Promise<void> {
    await this.query(
      `INSERT INTO vfs_nodes (session_id, path, node_type, content)
       VALUES ($1, $2, 'file', $3)
       ON CONFLICT (session_id, path)
       DO UPDATE SET content = COALESCE(vfs_nodes.content, '') || EXCLUDED.content,
                     updated_at = now()`,
      [namespaceId, path, content],
      namespaceId,
    );
  }

  async insertDir(namespaceId: string, path: string): Promise<void> {
    await this.query(
      `INSERT INTO vfs_nodes (session_id, path, node_type)
       VALUES ($1, $2, 'directory')
       ON CONFLICT (session_id, path) DO NOTHING`,
      [namespaceId, path],
      namespaceId,
    );
  }

  async deleteNode(namespaceId: string, path: string): Promise<number> {
    const { rowCount } = await this.query(
      `DELETE FROM vfs_nodes
       WHERE session_id = $1 AND (path = $2 OR path LIKE $3)`,
      [namespaceId, path, path + "/%"],
      namespaceId,
    );
    return rowCount ?? 0;
  }

  async moveNode(
    namespaceId: string,
    sourcePath: string,
    destPath: string,
  ): Promise<void> {
    // Update the node itself and all descendants in a single UPDATE.
    // For the source node: path becomes destPath.
    // For descendants: replace the sourcePath prefix with destPath.
    await this.query(
      `UPDATE vfs_nodes
       SET path = $3 || substr(path, length($2) + 1),
           updated_at = now()
       WHERE session_id = $1
         AND (path = $2 OR path LIKE $2 || '/%')`,
      [namespaceId, sourcePath, destPath],
      namespaceId,
    );
  }

  // ── Search ─────────────────────────────────────────────────

  async allFilePaths(namespaceId: string): Promise<string[]> {
    const { rows } = await this.query<{ path: string }>(
      `SELECT path FROM vfs_nodes
       WHERE session_id = $1 AND node_type = 'file'
       ORDER BY path`,
      [namespaceId],
      namespaceId,
    );
    return rows.map((r) => r.path);
  }

  async grepContent(
    namespaceId: string,
    pattern: string,
    pathFilter?: string,
  ): Promise<GrepMatch[]> {
    // Line-level matching is done entirely in PostgreSQL to avoid
    // ReDoS risk from JS RegExp on user-supplied patterns.
    let query = `
      WITH matched_files AS (
        SELECT path, content FROM vfs_nodes
        WHERE session_id = $1
          AND node_type = 'file'
          AND content IS NOT NULL
          AND content ~ $2`;
    const params: unknown[] = [namespaceId, pattern];

    if (pathFilter) {
      query += ` AND path LIKE $3`;
      params.push(pathFilter);
    }

    query += `
      )
      SELECT f.path, t.ordinality::integer AS line_number, t.line
      FROM matched_files f,
           regexp_split_to_table(f.content, E'\\n') WITH ORDINALITY AS t(line, ordinality)
      WHERE t.line ~ $2
      ORDER BY f.path, t.ordinality`;

    const { rows } = await this.query<{ path: string; line_number: number; line: string }>(
      query,
      params,
      namespaceId,
    );

    return rows.map((r) => ({
      path: r.path,
      lineNumber: r.line_number,
      line: r.line,
    }));
  }
}
