-- Virtual Filesystem MCP Server — Database Schema
-- Run: psql $DATABASE_URL -f sql/schema.sql

-- Sessions / namespaces table
-- Dual purpose: ephemeral session namespaces + persistent named stores
CREATE TABLE IF NOT EXISTS vfs_sessions (
    id TEXT PRIMARY KEY,
    is_persistent BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Filesystem nodes (files + directories)
CREATE TABLE IF NOT EXISTS vfs_nodes (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES vfs_sessions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    node_type TEXT NOT NULL CHECK (node_type IN ('file', 'directory')),
    content TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, path)
);

-- Prefix index for ls/rm (LIKE 'prefix%' queries)
CREATE INDEX IF NOT EXISTS idx_vfs_nodes_path_prefix
    ON vfs_nodes (session_id, path text_pattern_ops);

-- Trigram index for grep (regex on content)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_vfs_nodes_content_trgm
    ON vfs_nodes USING gin (content gin_trgm_ops)
    WHERE node_type = 'file' AND content IS NOT NULL;
