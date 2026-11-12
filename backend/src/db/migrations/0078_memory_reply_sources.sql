-- Which memories and past-conversation turns each reply repeated, of what the conversation's session was
-- given (services/memory/replySources.ts). Ids only, never text. Additive only.
CREATE TABLE IF NOT EXISTS memory_turn_sources (
  turn_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,          -- 'memory' | 'conversation' (validated by the app)
  item_id TEXT NOT NULL,            -- memories.id, or memory_recall_docs.id as text
  owner_user_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  rank INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (turn_id, item_kind, item_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_turn_sources_item ON memory_turn_sources(item_kind, item_id);
CREATE INDEX IF NOT EXISTS idx_memory_turn_sources_node ON memory_turn_sources(node_id);
CREATE TRIGGER IF NOT EXISTS memory_turn_sources_node_purged AFTER UPDATE OF purged_at ON nodes
WHEN new.purged_at IS NOT NULL BEGIN DELETE FROM memory_turn_sources WHERE node_id = new.id; END;
CREATE TRIGGER IF NOT EXISTS memory_turn_sources_node_ad AFTER DELETE ON nodes
BEGIN DELETE FROM memory_turn_sources WHERE node_id = old.id; END;
CREATE TRIGGER IF NOT EXISTS memory_turn_sources_memory_ad AFTER DELETE ON memories
BEGIN DELETE FROM memory_turn_sources WHERE item_kind = 'memory' AND item_id = old.id; END;
CREATE TRIGGER IF NOT EXISTS memory_turn_sources_doc_hidden AFTER UPDATE OF hidden ON memory_recall_docs
WHEN new.hidden = 1 AND new.doc_kind = 'turn'
BEGIN DELETE FROM memory_turn_sources WHERE item_kind = 'conversation' AND item_id = CAST(new.id AS TEXT); END;
CREATE TRIGGER IF NOT EXISTS memory_turn_sources_doc_ad AFTER DELETE ON memory_recall_docs WHEN old.doc_kind = 'turn'
BEGIN DELETE FROM memory_turn_sources WHERE item_kind = 'conversation' AND item_id = CAST(old.id AS TEXT); END;
