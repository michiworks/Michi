-- Server attention (services/attention/): the completion and seen facts the
-- unread mark and notifications are decided from, and the notification records
-- every window presents.
--
-- completion_seq counts this node's turns that completed with an answer. It is
-- written in the transaction that finalizes the turn (turnPersistence.core.ts),
-- with the latest such turn and its completion time. seen_completion_seq is the
-- highest completion a focused window had on screen (written by the view mark,
-- domainCommands.ts, never above completion_seq): the node is unread while
-- completion_seq > seen_completion_seq. Not turns.completion_seq, which numbers
-- a workspace's conversation updates.
ALTER TABLE nodes ADD COLUMN completion_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN last_completed_at INTEGER;
ALTER TABLE nodes ADD COLUMN last_completed_turn_id TEXT;
ALTER TABLE nodes ADD COLUMN seen_completion_seq INTEGER NOT NULL DEFAULT 0;

-- One row per notification the server decided to deliver. key names the slot
-- (one per target): at most one row per owner and key is active, and a newer
-- fact for the key resolves the older row as 'superseded'. fact names the
-- event itself (a turn's completion, a permission request, a Run's terminal
-- status), so an event observed twice is delivered once.
-- claimed_by_window_id is the one window allowed to show the OS-level
-- notification: the first to claim it.
CREATE TABLE IF NOT EXISTS attention_notifications (
  id                   TEXT PRIMARY KEY,
  owner_user_id        TEXT NOT NULL,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type          TEXT NOT NULL CHECK (target_type IN ('node', 'agent_run')),
  target_id            TEXT NOT NULL,
  key                  TEXT NOT NULL,
  fact                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('needs_input', 'finished', 'failed')),
  reason               TEXT NOT NULL CHECK (reason IN ('approval', 'question', 'completed', 'error', 'run_completed', 'run_failed')),
  title                TEXT NOT NULL,
  body                 TEXT NOT NULL DEFAULT '',
  created_at           INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'expired')),
  resolve_reason       TEXT CHECK (resolve_reason IS NULL OR resolve_reason IN ('answered', 'seen', 'stale', 'superseded', 'expired')),
  claimed_by_window_id TEXT,
  claimed_at           INTEGER,
  resolved_at          INTEGER,
  CHECK ((status = 'active') = (resolved_at IS NULL)),
  CHECK ((status = 'active') = (resolve_reason IS NULL)),
  CHECK ((claimed_by_window_id IS NULL) = (claimed_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_active_key
  ON attention_notifications(owner_user_id, key) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_fact
  ON attention_notifications(owner_user_id, key, fact);
CREATE INDEX IF NOT EXISTS idx_attention_owner_status
  ON attention_notifications(owner_user_id, status, created_at);
-- Serves the ON DELETE CASCADE lookup from workspaces.
CREATE INDEX IF NOT EXISTS idx_attention_workspace
  ON attention_notifications(workspace_id);
