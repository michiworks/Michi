-- Search reads each matching message's created_at (the grouped search's last
-- message per conversation, the title search's last message time). The column
-- is stored after tool_calls (up to 1.8 MB a row), so reading it from the table
-- walks the row's whole overflow chain: on a cold or fragmented data.db one
-- search of a common word read 19-28 thousand pages and froze the backend for
-- 14 and 34 s (11-09 performance audit, P0-5). This index holds node_id, role,
-- created_at and the rowid; routes/search.ts reads created_at from it.
-- The same per-conversation MAX(created_at) reads elsewhere (Spaces Home
-- sections, the assistant's list, first-run history) are covered by it as well.
-- Its (node_id, role) prefix replaces idx_messages_node_role (0022).
CREATE INDEX IF NOT EXISTS idx_messages_node_role_created ON messages(node_id, role, created_at);
DROP INDEX IF EXISTS idx_messages_node_role;
