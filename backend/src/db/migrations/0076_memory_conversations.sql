-- Michi Memory, round 7: automatic extraction reads one conversation at a
-- time, and each conversation has its own memory setting
-- (services/memory/extractionRun.ts, conversationMemory.ts). Additive only:
-- no CHECK changes and no table rebuild.

-- A conversation's memory setting: NULL is learn (the default), 'use_only'
-- (memory is read, nothing from the conversation is indexed, extracted or
-- saved) or 'off' (not read either). The app validates the value.
ALTER TABLE nodes ADD COLUMN memory_mode TEXT;

-- How far extraction has read each conversation (a chat node): the newest
-- completion position (turns.completion_seq) of the conversation it settled,
-- read or skipped. A conversation without a row starts at its workspace's
-- extraction cursor (memory_extraction_cursors.completion_cursor), which no
-- turn at or below is ever read past; rows at or below that cursor are
-- deleted as it moves. No text, and no foreign keys, like the other
-- extraction tables: workspace and owner purges delete these rows themselves.
CREATE TABLE IF NOT EXISTS memory_extraction_conversations (
  node_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  extracted_seq INTEGER NOT NULL CHECK (extracted_seq >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, owner_user_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_extraction_conversations_workspace
  ON memory_extraction_conversations(workspace_id, owner_user_id);

-- The user asked for a rebuild of their profile (Settings › Memory): the next
-- run rebuilds it whatever its cadence says. NULL when none is waiting.
ALTER TABLE memory_user_profiles ADD COLUMN requested_at INTEGER;
