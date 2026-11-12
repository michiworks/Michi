-- Michi Memory, consolidation (services/memory/consolidation.ts): Michi puts away its own notes that repeat
-- another note or that a newer note replaced. It never writes text and never deletes. Additive only.

-- Set on a superseded memory that consolidation merged into another (the note it repeats, or the newer note
-- that replaced it); NULL otherwise. Forgetting that note forgets this one too; removing it otherwise brings
-- this one back (memoryService.removeMemory). No foreign key, like the other memory columns.
ALTER TABLE memories ADD COLUMN merged_into_id TEXT;
-- When the user last edited the memory in Settings › Memory (PATCH /api/memories/:id). Such a memory is the
-- user's own for consolidation, which never changes it.
ALTER TABLE memories ADD COLUMN user_edited_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_memories_merged_into ON memories(merged_into_id) WHERE merged_into_id IS NOT NULL;
-- What consolidation has looked at: every memory written or changed after the cursor waits.
CREATE INDEX IF NOT EXISTS idx_memories_owner_updated ON memories(owner_user_id, updated_at, row_id);

-- One row per owner: the cursor (a memory's (updated_at, row_id) at or below it has been looked at) and the
-- cursor the live run will move it to when it commits. No text.
CREATE TABLE IF NOT EXISTS memory_consolidation_state (
  owner_user_id TEXT PRIMARY KEY,
  cursor_at INTEGER NOT NULL DEFAULT 0,
  cursor_row INTEGER NOT NULL DEFAULT 0,
  planned_run_id TEXT,
  planned_at INTEGER,
  planned_row INTEGER,
  updated_at INTEGER NOT NULL
);
-- No backfill: what an owner already has counts as looked at.
INSERT OR IGNORE INTO memory_consolidation_state (owner_user_id, cursor_at, cursor_row, updated_at)
  SELECT owner_user_id, MAX(updated_at), MAX(row_id), CAST(strftime('%s','now') AS INTEGER) * 1000
  FROM memories GROUP BY owner_user_id;

-- What each run listed and decided (internal; kept about 7 days). An applied row is the change's preimage:
-- the memory was active at listed_version with no merge link. Ids only, never text; the model's reasons are
-- never stored. No foreign keys; purges and the 7-day prune delete rows.
CREATE TABLE IF NOT EXISTS memory_consolidation_log (
  run_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  role TEXT NOT NULL,              -- 'input' | 'neighbour' (validated by the app)
  listed_version INTEGER NOT NULL,
  decision TEXT,                   -- 'keep' | 'duplicate' | 'outdated'; NULL: none given
  into_id TEXT,
  outcome TEXT NOT NULL,           -- 'applied' | 'kept' | 'skipped:<reason>' | 'unreadable' | 'no_pair' | 'reverted'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_consolidation_log_owner ON memory_consolidation_log(owner_user_id, created_at);
