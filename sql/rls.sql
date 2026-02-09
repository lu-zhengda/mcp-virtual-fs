-- Virtual Filesystem MCP Server — Row Level Security
-- Run AFTER schema.sql when RLS is desired:
--   psql $DATABASE_URL -f sql/rls.sql
--
-- Then connect with the vfs_app role and set VFS_ENABLE_RLS=true

-- 1. Create an application role (non-superuser, cannot bypass RLS)
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

-- 2. Enable RLS on both tables
ALTER TABLE vfs_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE vfs_nodes ENABLE ROW LEVEL SECURITY;

-- 3. Policies: access own session rows + all persistent store rows

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
