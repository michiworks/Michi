-- Michi Companion (shared/src/companion.ts): the global, proactive agent's
-- own state. services/companion/repository.ts owns every query; single-value
-- state lives in `meta` under `companion:*` keys. owner_user_id is the local
-- agent owner ('local-user', LOCAL_AGENT_OWNER_ID in services/agentOwner.ts):
-- the Companion exists only in the local app, and the column stays so a later
-- multi-owner backend needs no table rewrite. Times are epoch ms.

-- The last normalized state of every watched object, to diff against and to
-- tell how long it has stayed unchanged (fingerprint_since). missing_count
-- counts the successful, complete polls in a row that did not report the
-- object; the second one drops the row (the object left its source).
CREATE TABLE IF NOT EXISTS companion_snapshots (
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  source TEXT NOT NULL,
  object_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state_json TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  fingerprint_since INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  missing_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_user_id, source, object_key)
);

-- The feed the user sees: one row per object, in its current state.
-- prior_status keeps the status an item had when it resolved, so an object
-- that comes back reopens as it was (seen stays seen). missing_count counts
-- the successful, complete polls in a row whose drafts left the item out; the
-- second one resolves it.
CREATE TABLE IF NOT EXISTS companion_items (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  source TEXT NOT NULL,
  subtype TEXT NOT NULL,
  item_key TEXT NOT NULL,
  version TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('needs_you','update','stalled','fyi')),
  severity TEXT NOT NULL CHECK (severity IN ('now','digest','silent')),
  title TEXT NOT NULL,
  summary TEXT,
  target_json TEXT,
  facts_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','seen','snoozed','dismissed','muted','resolved')),
  prior_status TEXT CHECK (prior_status IN ('new','seen','snoozed','dismissed')),
  snoozed_until INTEGER,
  feedback TEXT CHECK (feedback IN ('up','down')),
  feedback_reason TEXT,
  first_seen_at INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  observed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  notified_version TEXT,
  missing_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner_user_id, item_key)
);
CREATE INDEX IF NOT EXISTS idx_companion_items_open ON companion_items(owner_user_id, status, changed_at);
CREATE INDEX IF NOT EXISTS idx_companion_items_source ON companion_items(owner_user_id, source, status);

-- Append-only log: an item was created, changed meaningfully, resolved or
-- reopened; `baseline` is an object first seen by its source's first poll
-- (never turn material, never notified). Heartbeats and briefs read "what
-- changed since" by seq cursor.
CREATE TABLE IF NOT EXISTS companion_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created','changed','resolved','reopened','baseline')),
  version TEXT NOT NULL,
  severity TEXT NOT NULL,
  summary TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companion_events_owner ON companion_events(owner_user_id, seq);
CREATE INDEX IF NOT EXISTS idx_companion_events_item ON companion_events(owner_user_id, item_id, seq);

-- The Activity log: every poll and every Companion turn. A turn records its
-- chat turn (turn_id) and the assistant message it produced (message_id).
CREATE TABLE IF NOT EXISTS companion_runs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  kind TEXT NOT NULL,
  trigger TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT,
  turn_id TEXT,
  message_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_companion_runs_owner ON companion_runs(owner_user_id, started_at);

CREATE TABLE IF NOT EXISTS companion_goals (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  text TEXT NOT NULL,
  progress TEXT,
  progress_at INTEGER,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER
);

-- Changes the Companion proposes; only the user's Apply (REST) makes them.
CREATE TABLE IF NOT EXISTS companion_cards (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','dismissed','expired','failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  expires_at INTEGER NOT NULL,
  reported_at INTEGER
);

CREATE TABLE IF NOT EXISTS companion_briefs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  date TEXT NOT NULL,
  headline TEXT NOT NULL,
  cards_json TEXT NOT NULL,
  closing TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('llm','fallback')),
  card_feedback_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE (owner_user_id, date, origin)
);

-- Desktop notification outbox, replayed until acknowledged (as
-- scheduled_job_runs.notify_state) while it has not expired and its items are
-- still open at the versions it was about (item_versions_json).
CREATE TABLE IF NOT EXISTS companion_notices (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  target_json TEXT NOT NULL,
  item_ids_json TEXT NOT NULL DEFAULT '[]',
  item_versions_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_companion_notices_pending ON companion_notices(owner_user_id, delivered_at, created_at);

-- Conversations the Companion started (its workers), through an applied
-- conversation.start card.
CREATE TABLE IF NOT EXISTS companion_delegations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_reported_message_id TEXT,
  last_reported_at INTEGER,
  closed_at INTEGER,
  UNIQUE (owner_user_id, node_id)
);

-- Reminders and watches the user asked for (CompanionReminderDto): kept by
-- Michi, not by the model's memory. time = once at `at`, or daily at
-- `daily_at` (last_fired_date keeps it to once a day); watch = when item_id
-- reaches `until`. A one-off reminder or a watch ends `fired`.
CREATE TABLE IF NOT EXISTS companion_reminders (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  kind TEXT NOT NULL CHECK (kind IN ('time','watch')),
  text TEXT NOT NULL,
  at INTEGER,
  daily_at TEXT,
  item_id TEXT,
  until TEXT CHECK (until IN ('approved','merged','recovered','read','answered')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','fired','cancelled')),
  created_at INTEGER NOT NULL,
  fired_at INTEGER,
  last_fired_date TEXT
);
CREATE INDEX IF NOT EXISTS idx_companion_reminders_owner ON companion_reminders(owner_user_id, status, created_at);
