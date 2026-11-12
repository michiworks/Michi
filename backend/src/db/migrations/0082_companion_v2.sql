-- Companion v2: one
-- visible conversation V, every hidden turn a check-in in a throwaway node S
-- (`n-cmph-<runId>`) that posts into V only what it said or changed. Purely
-- additive: new columns and one new table, nothing rewritten, so a revert of
-- the v2 code reads the same data as before (§7 rollback). The renumbering
-- at the dev merge keeps the file's content.

-- A check-in's run: its throwaway node and the native session it ran on
-- (discarded after the run, retried at boot until the runtime answers, §3.7),
-- the message it posted into V (`cmp-post-<runId>`) and when, when the user's
-- next turn was told of it (§3.5), and for a `send` run its delegation (§4).
-- checkin_cwd and profile_hash: what discarding the native record needs once
-- S's row is purged (chatManager EphemeralSessionRecord). reply_chars: the
-- length of a superseded reply, kept instead of its text (§3.3).
-- changes_json: what the run changed, as its post's receipt lists it
-- (CompanionPostChange[]), written when it posts; undone_at: when "Undo all"
-- left none of it standing (CompanionRunDto.undoneAt). native_kept_at: when
-- the runtime answered that it keeps the native record (`unsupported`): final,
-- boot cleanup stops asking (discarded_at stays null: it is not gone).
ALTER TABLE companion_runs ADD COLUMN checkin_node_id TEXT;
ALTER TABLE companion_runs ADD COLUMN runtime_id TEXT;
ALTER TABLE companion_runs ADD COLUMN native_session_id TEXT;
ALTER TABLE companion_runs ADD COLUMN checkin_cwd TEXT;
ALTER TABLE companion_runs ADD COLUMN profile_hash TEXT;
ALTER TABLE companion_runs ADD COLUMN posted_message_id TEXT;
ALTER TABLE companion_runs ADD COLUMN posted_at INTEGER;
ALTER TABLE companion_runs ADD COLUMN told_at INTEGER;
ALTER TABLE companion_runs ADD COLUMN discarded_at INTEGER;
ALTER TABLE companion_runs ADD COLUMN delegation_id TEXT;
ALTER TABLE companion_runs ADD COLUMN reply_chars INTEGER;
ALTER TABLE companion_runs ADD COLUMN changes_json TEXT;
ALTER TABLE companion_runs ADD COLUMN undone_at INTEGER;
ALTER TABLE companion_runs ADD COLUMN native_kept_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_companion_runs_checkin ON companion_runs(owner_user_id, checkin_node_id) WHERE checkin_node_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companion_runs_posted ON companion_runs(owner_user_id, posted_at) WHERE posted_at IS NOT NULL;

-- Delegations the agent follows (§4). Every row from before v2 is closed: an
-- upgrade never makes an old worker a target of session_send.
ALTER TABLE companion_delegations ADD COLUMN state TEXT NOT NULL DEFAULT 'closed';
ALTER TABLE companion_delegations ADD COLUMN origin TEXT;
ALTER TABLE companion_delegations ADD COLUMN last_sent_at INTEGER;
ALTER TABLE companion_delegations ADD COLUMN closed_reason TEXT;
ALTER TABLE companion_delegations ADD COLUMN auto_send INTEGER NOT NULL DEFAULT 0;

-- What a check-in changed in Today and the goals (§2.6.5, §2.7): Today's
-- "by <name>", the receipt's lines and "Undo all" read it. companion_events
-- keeps its CHECK (0063) and stays the item log.
CREATE TABLE IF NOT EXISTS companion_run_changes (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  run_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('item','goal')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_companion_run_changes_run ON companion_run_changes(run_id);
CREATE INDEX IF NOT EXISTS idx_companion_run_changes_target ON companion_run_changes(target_kind, target_id, created_at);

-- Who wrote a goal's text (CompanionTextOrigin): only `user` text goes into
-- V's [COMPANION CONTEXT] (§2.8 T1).
ALTER TABLE companion_goals ADD COLUMN text_origin TEXT NOT NULL DEFAULT 'user';

-- conv-1: a rating belongs to the version it was given on, and the too_noisy
-- count of a subtype restarts when the user undoes its demotion.
ALTER TABLE companion_items ADD COLUMN feedback_version TEXT;
ALTER TABLE companion_items ADD COLUMN feedback_at INTEGER;
UPDATE companion_items SET feedback_version = version, feedback_at = updated_at WHERE feedback IS NOT NULL AND feedback_version IS NULL;

-- Read-time source resolution and taint look page changes up by their source node (§2.7, §2.8 T5).
CREATE INDEX IF NOT EXISTS idx_page_changes_source_node ON page_changes(source_node_id);
CREATE INDEX IF NOT EXISTS idx_page_changes_database_source ON page_changes(database_id, source_node_id);
