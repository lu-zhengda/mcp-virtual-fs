import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgresBackend } from "../../src/storage/postgres.js";

let container: StartedPostgreSqlContainer | null = null;
let refCount = 0;

/**
 * Get or start a shared PostgreSQL container.
 * Returns a fresh PostgresBackend with schema initialized.
 * Call `releaseContainer()` in afterAll to clean up.
 */
export async function getTestBackend(): Promise<PostgresBackend> {
  if (!container) {
    container = await new PostgreSqlContainer("postgres:16-alpine")
      .withDatabase("vfs_test")
      .start();
  }
  refCount++;

  const backend = new PostgresBackend({
    connectionString: container.getConnectionUri(),
    enableRls: false,
  });

  await backend.initSchema();
  return backend;
}

/** Get the connection URI for the shared container. */
export function getConnectionUri(): string {
  if (!container) throw new Error("Container not started");
  return container.getConnectionUri();
}

/** Release ref to the shared container. Stops it when all refs are released. */
export async function releaseContainer(): Promise<void> {
  refCount--;
  if (refCount <= 0 && container) {
    await container.stop();
    container = null;
    refCount = 0;
  }
}
