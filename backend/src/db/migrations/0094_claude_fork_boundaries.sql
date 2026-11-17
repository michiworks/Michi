-- When a chat's Claude session was forked from its parent's. Each spawn of the
-- child passes it to the CLI, so the CLI does not report the background work
-- launched in the copied history (it runs in the parent) as interrupted.
CREATE TABLE claude_fork_boundaries (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    native_session_id TEXT NOT NULL,
    boundary_at TEXT NOT NULL,
    PRIMARY KEY (node_id, native_session_id)
);
