-- One notification path (services/attention/): Michi's own posts and its
-- Today's Needs you, and Scheduled Job runs, become attention records like a
-- conversation's. SQLite cannot alter a CHECK, so attention_notifications is
-- rebuilt with two more target types and two more reasons, and a column for
-- what a target needs beyond its id:
--   target_type 'agent'          target_id = the slot (`chat`, `item:<id>`, `node:<id>`),
--                                target_detail = where a click opens (CompanionTarget JSON);
--                                workspace_id = the assistant's (system) workspace.
--   target_type 'scheduled_run'  target_id = the run id,
--                                target_detail = {"jobId", "nodeId"} (nodeId null before its thread exists).
--   reason 'needs_you' (kind needs_input): an item in Today that needs the user now.
--   reason 'update'    (kind finished): a post of Michi's (the brief, a check-in, a delegated conversation that finished).
-- Every row is copied; the Companion's own outbox (companion_notices) is no
-- longer written, and its rows live two hours at most, so none is carried over.
DROP TABLE IF EXISTS attention_notifications_next;
CREATE TABLE attention_notifications_next (
  id                   TEXT PRIMARY KEY,
  owner_user_id        TEXT NOT NULL,
  workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type          TEXT NOT NULL CHECK (target_type IN ('node', 'agent_run', 'agent', 'scheduled_run')),
  target_id            TEXT NOT NULL,
  target_detail        TEXT CHECK (target_detail IS NULL OR json_valid(target_detail)),
  key                  TEXT NOT NULL,
  fact                 TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('needs_input', 'finished', 'failed')),
  reason               TEXT NOT NULL CHECK (reason IN ('approval', 'question', 'completed', 'error', 'run_completed', 'run_failed', 'needs_you', 'update')),
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
  CHECK ((claimed_by_window_id IS NULL) = (claimed_at IS NULL)),
  CHECK ((target_type IN ('agent', 'scheduled_run')) = (target_detail IS NOT NULL))
);
-- Foreign keys are on here: a row whose workspace is gone is left behind
-- (its cascade would have deleted it), so stale rows cannot abort the rebuild.
INSERT INTO attention_notifications_next (id, owner_user_id, workspace_id, target_type, target_id, target_detail, key, fact,
    kind, reason, title, body, created_at, status, resolve_reason, claimed_by_window_id, claimed_at, resolved_at)
  SELECT id, owner_user_id, workspace_id, target_type, target_id, NULL, key, fact,
         kind, reason, title, body, created_at, status, resolve_reason, claimed_by_window_id, claimed_at, resolved_at
  FROM attention_notifications
  WHERE workspace_id IN (SELECT id FROM workspaces);
DROP TABLE attention_notifications;
ALTER TABLE attention_notifications_next RENAME TO attention_notifications;
CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_active_key
  ON attention_notifications(owner_user_id, key) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_attention_fact
  ON attention_notifications(owner_user_id, key, fact);
CREATE INDEX IF NOT EXISTS idx_attention_owner_status
  ON attention_notifications(owner_user_id, status, created_at);
-- Serves the ON DELETE CASCADE lookup from workspaces.
CREATE INDEX IF NOT EXISTS idx_attention_workspace
  ON attention_notifications(workspace_id);
