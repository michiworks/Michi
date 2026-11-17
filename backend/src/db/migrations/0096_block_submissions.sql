-- What a person sent through an interactive block (form, poll, choice), so the
-- block shows it read-only after a reload (services/pages/blockSubmissions.ts).
-- One row per owner, workspace, host, block and signature of the block's
-- interactive content; the first write wins. The host is a page (page_id) or
-- one chat message (node_id, message_id); host_key is 'page:<pageId>' or
-- 'chat:<nodeId>:<messageId>'. Rows go when their host row is removed: a
-- purged page, a purged node's messages, a collected workspace.
CREATE TABLE IF NOT EXISTS block_submissions (
  owner_user_id TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  host_key      TEXT NOT NULL,
  page_id       TEXT REFERENCES pages(id) ON DELETE CASCADE,
  node_id       TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  message_id    TEXT REFERENCES messages(id) ON DELETE CASCADE,
  block_id      TEXT NOT NULL,
  signature     TEXT NOT NULL,
  value         TEXT NOT NULL CHECK (json_valid(value)),
  text          TEXT NOT NULL,
  submitted_at  INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, workspace_id, host_key, block_id, signature),
  CHECK (
    (page_id IS NOT NULL AND node_id IS NULL AND message_id IS NULL AND host_key = 'page:' || page_id) OR
    (page_id IS NULL AND node_id IS NOT NULL AND message_id IS NOT NULL AND host_key = 'chat:' || node_id || ':' || message_id)
  )
);

-- The cascades find a removed host's rows.
CREATE INDEX IF NOT EXISTS idx_block_submissions_page ON block_submissions (page_id) WHERE page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_submissions_node ON block_submissions (node_id) WHERE node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_block_submissions_message ON block_submissions (message_id) WHERE message_id IS NOT NULL;
