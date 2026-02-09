# mcp-virtual-fs

[![npm version](https://img.shields.io/npm/v/mcp-virtual-fs)](https://www.npmjs.com/package/mcp-virtual-fs)
[![CI](https://github.com/lu-zhengda/mcp-virtual-fs/actions/workflows/ci.yml/badge.svg)](https://github.com/lu-zhengda/mcp-virtual-fs/actions/workflows/ci.yml)
[![npm package size](https://img.shields.io/bundlephobia/min/mcp-virtual-fs)](https://bundlephobia.com/package/mcp-virtual-fs)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/mcp-virtual-fs)](https://nodejs.org)

A PostgreSQL-backed virtual filesystem exposed via [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) tools. Gives AI agents persistent, session-isolated file operations that survive container restarts and scale across deployments.

## Why

Agents work well with filesystems for context management, but coupling storage to the agent runtime means data is lost when pods restart or containers are recycled. This MCP server decouples storage from runtime:

- **Persistent storage** — files survive process restarts, stored in PostgreSQL
- **Session isolation** — each agent session gets its own namespace automatically
- **Cross-session stores** — named persistent stores for long-term agent memory
- **Standard file operations** — 11 tools that mirror familiar POSIX commands
- **Row Level Security** — optional database-enforced isolation between sessions

## Quick Start

### 1. Set up PostgreSQL

You need a PostgreSQL instance with the `pg_trgm` extension.

```bash
# Using Docker
docker run -d --name vfs-postgres \
  -e POSTGRES_DB=vfs \
  -e POSTGRES_PASSWORD=postgres \
  -p 5432:5432 \
  postgres:16-alpine
```

### 2. Configure your MCP client

Add to your MCP client config (e.g., Claude Desktop `claude_desktop_config.json` or Claude Code `.mcp.json`):

```json
{
  "mcpServers": {
    "virtual-fs": {
      "command": "npx",
      "args": ["-y", "mcp-virtual-fs"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/vfs",
        "VFS_AUTO_INIT": "true"
      }
    }
  }
}
```

That's it. `VFS_AUTO_INIT=true` creates the tables on first run.

### 3. Use the tools

Tool names are short POSIX-style names:

```
write({ path: "/notes/todo.md", content: "# My Tasks\n- Ship feature" })
read({ path: "/notes/todo.md" })
ls({ path: "/notes" })
glob({ pattern: "**/*.md" })
grep({ pattern: "TODO" })
```

All tools return structured JSON responses.

## Tools

| Tool | Parameters | Returns | Description |
|------|-----------|---------|-------------|
| `read` | `path` | `{content, size}` | Read file contents |
| `write` | `path`, `content` | `{path, size, created_parents}` | Write file (creates parents automatically) |
| `append` | `path`, `content` | `{path, appended_bytes}` | Append to file (creates if missing) |
| `stat` | `path` | `{exists, type?, size?, children?}` | Check existence and get metadata |
| `ls` | `path` | `{entries: [{name, type}]}` | List directory (dirs first, then alphabetical) |
| `mkdir` | `path` | `{path, already_existed}` | Create directory and parents (mkdir -p) |
| `rm` | `path` | `{path, deleted}` | Remove file or directory recursively |
| `move` | `source`, `destination` | `{source, destination}` | Move/rename file or directory |
| `glob` | `pattern` | `{files, count}` | Find files by glob (e.g., `**/*.ts`, `**/*.{js,ts}`) |
| `grep` | `pattern`, `path_filter?` | `{matches, count}` | Search file contents by regex |
| `list_stores` | *(none)* | `{stores, count}` | List all persistent store names |

All tools (except `list_stores`) accept an optional `store` parameter for cross-session persistent storage.

## Session Management

Sessions are handled automatically — no session ID in tool parameters.

**How it works:**

| Transport | Session identity | Behavior |
|-----------|-----------------|----------|
| stdio | Auto-generated UUID per process | Each MCP connection = unique session |
| HTTP/SSE | Transport-provided `sessionId` | MCP protocol handles it |
| Any | `VFS_SESSION_ID` env var | Deterministic/resumable sessions |

Priority: transport `sessionId` > `VFS_SESSION_ID` env var > auto-generated UUID.

### Resumable sessions

To resume a previous session across process restarts, set a deterministic session ID:

```json
{
  "env": {
    "DATABASE_URL": "postgresql://...",
    "VFS_SESSION_ID": "my-agent-session-1"
  }
}
```

## Cross-Session Stores

Named stores persist across sessions. Any session can read/write to a store by passing the `store` parameter:

```
// Session A writes to a store
write({ path: "/context.md", content: "project notes", store: "agent-memory" })

// Session B (days later) reads from the same store
read({ path: "/context.md", store: "agent-memory" })

// Without `store`, operations target the session's own namespace
write({ path: "/scratch.txt", content: "session-only data" })

// List all available stores
list_stores()
```

Stores are auto-created on first use.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | Yes | — | PostgreSQL connection string |
| `VFS_AUTO_INIT` | No | `false` | Auto-create tables on startup |
| `VFS_SESSION_ID` | No | random UUID | Deterministic session ID |
| `VFS_ENABLE_RLS` | No | `false` | Enable Row Level Security |
| `VFS_STORAGE_BACKEND` | No | `postgres` | Storage backend type |

## Manual Database Setup

If you prefer to manage the schema yourself instead of using `VFS_AUTO_INIT`:

```bash
psql $DATABASE_URL -f sql/schema.sql
```

### Row Level Security (optional)

RLS provides database-enforced session isolation. Even if application code has a bug that omits a `WHERE session_id =` clause, PostgreSQL itself prevents cross-session access.

```bash
# Run after schema.sql
psql $DATABASE_URL -f sql/rls.sql

# Update the vfs_app password
psql $DATABASE_URL -c "ALTER ROLE vfs_app PASSWORD 'your-secure-password'"
```

Then configure the MCP server to connect as `vfs_app`:

```json
{
  "env": {
    "DATABASE_URL": "postgresql://vfs_app:your-secure-password@localhost:5432/vfs",
    "VFS_ENABLE_RLS": "true"
  }
}
```

## Architecture

```
MCP Client (Claude, agent, etc.)
    ↓ stdio / HTTP
┌───────────────────────────────────┐
│  tools.ts — 11 MCP tool handlers │
│  vfs.ts — filesystem semantics    │
│  storage/interface.ts — abstract  │
│  storage/postgres.ts — PG impl   │
└───────────────────────────────────┘
    ↓ SQL
PostgreSQL (with optional RLS)
```

The storage backend is pluggable. `VirtualFS` depends only on the `StorageBackend` interface — never on a concrete implementation.

```
mcp-virtual-fs/
├── src/
│   ├── index.ts              # Entry point: env config, MCP server + stdio
│   ├── tools.ts              # 11 MCP tool registrations with Zod schemas
│   ├── vfs.ts                # VirtualFS class: filesystem semantics
│   ├── paths.ts              # Path normalization, validation, ancestors
│   └── storage/
│       ├── interface.ts      # StorageBackend interface + types
│       ├── postgres.ts       # PostgreSQL implementation
│       ├── schema.ts         # Embedded SQL for auto-init
│       └── index.ts          # Backend factory
├── sql/
│   ├── schema.sql            # Database schema
│   └── rls.sql               # Row Level Security setup
└── tests/
    ├── unit/                 # Pure function tests
    ├── integration/          # PostgreSQL Docker tests
    └── helpers/              # Testcontainers setup
```

## Development

```bash
git clone https://github.com/lu-zhengda/mcp-virtual-fs.git
cd mcp-virtual-fs
npm install
npm run build
```

### Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm test` | Run all tests (requires Docker) |
| `npm run test:unit` | Run unit tests only |
| `npm run test:integration` | Run integration tests only |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run dev` | Run with tsx (no build step) |

### Testing

Tests use [testcontainers](https://node.testcontainers.org/) to spin up real PostgreSQL instances in Docker. No mocks — the integration tests exercise actual SQL queries, trigram indexes, and RLS policies.

```bash
# Requires Docker running
npm test
```

## Session Cleanup

Ephemeral sessions can be cleaned up periodically:

```sql
DELETE FROM vfs_sessions
WHERE is_persistent = false
  AND created_at < now() - interval '7 days';
```

The `ON DELETE CASCADE` on `vfs_nodes` handles file cleanup automatically. Persistent stores (created via the `store` parameter) are never affected.

## License

MIT
