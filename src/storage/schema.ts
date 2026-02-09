/**
 * Embedded SQL schemas for auto-initialization.
 * Kept as string constants so they work reliably with npx / bundled installs.
 */

export const SCHEMA_SQL = `
-- Sessions / namespaces table
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
`;

export const RLS_SQL = `
-- Create application role (non-superuser, cannot bypass RLS)
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'vfs_app') THEN
        CREATE ROLE vfs_app LOGIN PASSWORD 'changeme';
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO vfs_app;
GRANT ALL ON vfs_sessions, vfs_nodes TO vfs_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO vfs_app;

-- Enable RLS on both tables
ALTER TABLE vfs_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vfs_nodes ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if re-running
DROP POLICY IF EXISTS vfs_sessions_isolation ON vfs_sessions;
DROP POLICY IF EXISTS vfs_nodes_isolation ON vfs_nodes;

CREATE POLICY vfs_sessions_isolation ON vfs_sessions
    USING (
        id = current_setting('app.vfs_session_id', true)
        OR is_persistent = true
    )
    WITH CHECK (
        id = current_setting('app.vfs_session_id', true)
        OR is_persistent = true
    );

CREATE POLICY vfs_nodes_isolation ON vfs_nodes
    USING (
        session_id = current_setting('app.vfs_session_id', true)
        OR session_id IN (SELECT id FROM vfs_sessions WHERE is_persistent = true)
    )
    WITH CHECK (
        session_id = current_setting('app.vfs_session_id', true)
        OR session_id IN (SELECT id FROM vfs_sessions WHERE is_persistent = true)
    );
`;
