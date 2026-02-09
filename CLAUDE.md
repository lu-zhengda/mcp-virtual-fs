# CLAUDE.md

This file provides context for AI assistants working on this codebase.

## Project Overview

`mcp-virtual-fs` is a PostgreSQL-backed virtual filesystem exposed via MCP (Model Context Protocol) tools. It gives AI agents persistent, session-isolated file operations.

## Tech Stack

- **Language:** TypeScript (ESM, strict mode)
- **Runtime:** Node.js 20+
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.x, stdio transport
- **Database:** PostgreSQL with `pg_trgm` extension
- **Testing:** Vitest + testcontainers (real PostgreSQL in Docker)
- **Linting:** ESLint 9 flat config + typescript-eslint strict

## Architecture

```
tools.ts (MCP protocol) → vfs.ts (filesystem semantics) → storage/interface.ts → storage/postgres.ts
```

Each layer depends only on the one below. `VirtualFS` never imports `postgres.ts` directly — it uses the `StorageBackend` interface.

### Key Design Decisions

- **Materialized paths** (not ltree) — filenames like `package.json` contain dots that ltree can't handle
- **Glob in-app** (picomatch) — `**/*.ts` can't be expressed as SQL LIKE; `allFilePaths()` fetches paths, picomatch filters
- **Grep in-database** — PostgreSQL trigram index (`pg_trgm`) makes regex search fast at the DB level
- **Session via MCP context** — `extra.sessionId` from transport, NOT a tool parameter. Falls back to `VFS_SESSION_ID` env var or auto-generated UUID
- **RLS uses `set_config()`** — PostgreSQL `SET variable = $1` doesn't support parameterized queries; `SELECT set_config('name', $1, false)` does

## Commands

```bash
npm run build          # Compile TypeScript
npm test               # Run all tests (needs Docker)
npm run test:unit      # Unit tests only (no Docker)
npm run test:integration  # Integration tests (needs Docker)
npm run lint           # ESLint
npm run lint:fix       # Auto-fix
```

## File Map

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point — env config, backend init, MCP server, stdio transport |
| `src/tools.ts` | 11 MCP tool registrations with Zod schemas and annotations |
| `src/vfs.ts` | `VirtualFS` class — filesystem semantics (read/write/append/stat/ls/mkdir/rm/mv/glob/grep/listStores) |
| `src/paths.ts` | Pure path utilities — normalize, parent, basename, ancestors, validate |
| `src/storage/interface.ts` | `StorageBackend` interface + `VfsNode`, `GrepMatch` types |
| `src/storage/postgres.ts` | PostgreSQL implementation with RLS-aware connection handling |
| `src/storage/schema.ts` | Embedded SQL constants for auto-init |
| `src/storage/index.ts` | `createBackend()` factory |

## Conventions

- **No default exports.** Use named exports everywhere.
- **Errors use POSIX codes.** `VfsError` has a `code` field: `ENOENT`, `EISDIR`, `ENOTDIR`, `EEXIST`, `EINVAL`.
- **Tool callbacks catch `VfsError`** and return `{ isError: true }` MCP responses. Other errors propagate.
- **All tool responses are structured JSON** (via `JSON.stringify`), not plain text. Error responses are plain text with `isError: true`.
- **Tool names are short POSIX-style** (`read`, `write`, `ls`, `mkdir`, `rm`, `glob`, `grep`, `stat`, `append`, `mv`, `stores`) — no `vfs_` prefix since MCP namespaces by server name.
- **SQL uses `ON CONFLICT DO NOTHING`** for idempotent operations (dirs, sessions).
- **SQL uses `ON CONFLICT DO UPDATE`** for upsert operations (file writes).
- **Tests use real PostgreSQL** via testcontainers. No mocks for storage. The shared container helper (`tests/helpers/pg-container.ts`) uses ref counting.

## Adding a New Storage Backend

1. Create `src/storage/yourbackend.ts` implementing `StorageBackend`
2. Add a case to `createBackend()` in `src/storage/index.ts`
3. No changes needed to `vfs.ts`, `tools.ts`, or `index.ts`

## Test Structure

- `tests/unit/` — Pure function tests, no I/O (fast, no Docker)
- `tests/integration/` — Real PostgreSQL via testcontainers
  - `vfs.test.ts` — All VFS operations + error cases
  - `store.test.ts` — Session isolation + cross-session stores
  - `rls.test.ts` — Row Level Security enforcement
  - `tools.test.ts` — Full MCP e2e via in-memory transport

## Known Gotchas

- `SET app.vfs_session_id = $1` does NOT work — use `SELECT set_config('app.vfs_session_id', $1, false)`
- RLS session variable must be set BEFORE any INSERT checked by the policy
- `StdioServerTransport` does not set `extra.sessionId` — it's only populated by HTTP/SSE transports
- The `pg_trgm` extension must exist in PostgreSQL for grep's trigram index
