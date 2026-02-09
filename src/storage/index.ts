import type { StorageBackend } from "./interface.js";
import { PostgresBackend } from "./postgres.js";

export type { StorageBackend, VfsNode, GrepMatch } from "./interface.js";

/** Create a storage backend based on environment configuration. */
export function createBackend(): StorageBackend {
  const type = process.env.VFS_STORAGE_BACKEND ?? "postgres";

  switch (type) {
    case "postgres": {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error("DATABASE_URL environment variable is required");
      }
      return new PostgresBackend({
        connectionString,
        enableRls: process.env.VFS_ENABLE_RLS === "true",
      });
    }
    default:
      throw new Error(`Unknown storage backend: ${type}`);
  }
}
