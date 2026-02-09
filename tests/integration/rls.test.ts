import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgresBackend } from "../../src/storage/postgres.js";
import { VirtualFS, VfsError } from "../../src/vfs.js";
import { SCHEMA_SQL, RLS_SQL } from "../../src/storage/schema.js";

const { Pool } = pg;

let container: StartedPostgreSqlContainer;
let ownerPool: pg.Pool;

beforeAll(async () => {
  // Start a fresh container for RLS tests (needs superuser to set up roles)
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("vfs_rls_test")
    .start();

  // Connect as superuser to set up schema + RLS
  ownerPool = new Pool({ connectionString: container.getConnectionUri() });
  await ownerPool.query(SCHEMA_SQL);
  await ownerPool.query(RLS_SQL);

  // Set a known password for the vfs_app role
  await ownerPool.query("ALTER ROLE vfs_app PASSWORD 'testpass'");
});

afterAll(async () => {
  await ownerPool.end();
  await container.stop();
});

function appConnectionUri(): string {
  // Build a connection URI using the vfs_app role
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  return `postgresql://vfs_app:testpass@${host}:${port}/vfs_rls_test`;
}

describe("Row Level Security", () => {
  it("session A's files are invisible to session B via RLS", async () => {
    // Create two separate backends, both connecting as vfs_app with RLS enabled
    const backendA = new PostgresBackend({
      connectionString: appConnectionUri(),
      enableRls: true,
    });
    const backendB = new PostgresBackend({
      connectionString: appConnectionUri(),
      enableRls: true,
    });

    const vfsA = new VirtualFS(backendA);
    const vfsB = new VirtualFS(backendB);

    try {
      // Session A writes a file
      await vfsA.write("rls-session-A", "/secret.txt", "A's secret");

      // Session B should not see it (ENOENT because the session's root is separate)
      await expect(
        vfsB.read("rls-session-B", "/secret.txt"),
      ).rejects.toThrow(VfsError);

      // Session A can still read its own file
      expect(await vfsA.read("rls-session-A", "/secret.txt")).toBe("A's secret");

      // Session B can write its own file at the same path
      await vfsB.write("rls-session-B", "/secret.txt", "B's secret");
      expect(await vfsB.read("rls-session-B", "/secret.txt")).toBe("B's secret");

      // Verify they're truly isolated — A still reads A's data
      expect(await vfsA.read("rls-session-A", "/secret.txt")).toBe("A's secret");
    } finally {
      await backendA.close();
      await backendB.close();
    }
  });

  it("persistent stores are accessible across sessions with RLS", async () => {
    const backendA = new PostgresBackend({
      connectionString: appConnectionUri(),
      enableRls: true,
    });
    const backendB = new PostgresBackend({
      connectionString: appConnectionUri(),
      enableRls: true,
    });

    const vfsA = new VirtualFS(backendA);
    const vfsB = new VirtualFS(backendB);

    try {
      // Session A writes to a persistent store
      await vfsA.write("rls-A", "/memo.md", "shared note", "rls-shared-store");

      // Session B reads from the same store
      const content = await vfsB.read("rls-B", "/memo.md", "rls-shared-store");
      expect(content).toBe("shared note");
    } finally {
      await backendA.close();
      await backendB.close();
    }
  });

  it("raw SQL without session variable returns no rows (RLS blocks)", async () => {
    // Connect as vfs_app without setting the session variable
    const appPool = new Pool({ connectionString: appConnectionUri() });

    try {
      // First, write some data as owner (bypasses RLS since owner is superuser)
      await ownerPool.query(
        `INSERT INTO vfs_sessions (id, is_persistent) VALUES ('raw-test', false) ON CONFLICT DO NOTHING`,
      );
      await ownerPool.query(
        `INSERT INTO vfs_nodes (session_id, path, node_type, content) VALUES ('raw-test', '/raw.txt', 'file', 'raw data') ON CONFLICT DO NOTHING`,
      );

      // Query as vfs_app without setting session variable — should return 0 rows
      const result = await appPool.query(
        `SELECT * FROM vfs_nodes WHERE session_id = 'raw-test'`,
      );
      expect(result.rows).toHaveLength(0);
    } finally {
      await appPool.end();
    }
  });
});
