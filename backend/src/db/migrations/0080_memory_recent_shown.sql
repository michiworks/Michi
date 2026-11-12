-- The memory pack's Recent conversations (services/memory/recentConversations.ts)
-- show only turns that read nothing from outside the conversation (turn_trust,
-- migration 0060: web pages, shell output, another MCP server's results), and
-- rank each conversation by the newest of them, so a chat whose newest turns
-- ran tools neither crowds out the others nor shows its old turns ahead of
-- theirs. A turn document says whether its turn read outside content
-- (read_outside), kept so by the triggers below whichever comes first, the
-- document or the turn's trust row; the index holds the documents Recent may
-- show, so the ranking stays one index-only lookup per conversation and a
-- conversation's turns one walk that stops after a few, however many of its
-- turns ran tools.
ALTER TABLE memory_recall_docs ADD COLUMN read_outside INTEGER NOT NULL DEFAULT 0 CHECK (read_outside IN (0, 1));

UPDATE memory_recall_docs SET read_outside = 1 WHERE doc_kind = 'turn'
  AND EXISTS (SELECT 1 FROM turn_trust tt WHERE tt.node_id = memory_recall_docs.node_id AND tt.turn_id = memory_recall_docs.ref_id);

-- A source a turn read, recorded after its document was written.
CREATE TRIGGER IF NOT EXISTS memory_recall_docs_turn_trust_ai AFTER INSERT ON turn_trust BEGIN
  UPDATE memory_recall_docs SET read_outside = 1
    WHERE doc_kind = 'turn' AND ref_id = new.turn_id AND node_id = new.node_id AND read_outside = 0;
END;

-- A document written for a turn whose sources were recorded before (the usual order: indexing follows the turn).
CREATE TRIGGER IF NOT EXISTS memory_recall_docs_read_outside_ai AFTER INSERT ON memory_recall_docs
WHEN new.doc_kind = 'turn' AND new.read_outside = 0
  AND EXISTS (SELECT 1 FROM turn_trust tt WHERE tt.node_id = new.node_id AND tt.turn_id = new.ref_id)
BEGIN
  UPDATE memory_recall_docs SET read_outside = 1 WHERE id = new.id;
END;

-- The parentheses matter: SQLite reads a partial index as covering when its WHERE fixes every other column the query
-- names, and it looks into `a AND (b AND c)` fully but only at the last two terms of `a AND b AND c`.
CREATE INDEX IF NOT EXISTS idx_memory_recall_docs_node_shown ON memory_recall_docs(node_id, at)
  WHERE doc_kind = 'turn' AND (hidden = 0 AND read_outside = 0);
