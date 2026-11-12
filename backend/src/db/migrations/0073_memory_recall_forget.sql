-- Michi Memory's recall index, part two (services/memory/recallIndex.ts):
-- what the user asked Michi not to recall stays out of recall, and a search
-- the agent asks for reads whole turns. Additive only: no CHECK changes and
-- no table rebuild.

-- hidden 1: a turn the user asked Michi not to recall (the reply footer's
-- Don't recall), of a conversation that stopped learning, or of an owner who
-- deleted all their memories. Its row keeps no text and no index entry, no
-- search returns it (includeInactive does not bring it back), and indexing
-- the turn again leaves it so.
ALTER TABLE memory_recall_docs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
-- A turn's whole indexed text ("user words\n→ reply", each side at most 16k
-- characters) when its snippet had to cut it; NULL when the snippet holds
-- all of it, and for memories.
ALTER TABLE memory_recall_docs ADD COLUMN content TEXT;

-- The terms of content that the snippet lacks (memory_recall_fts holds
-- those), keyed by memory_recall_docs.id like memory_recall_fts and with the
-- same options. A search the agent asks for matches both tables; automatic
-- recall only memory_recall_fts (what a snippet shows), so a word deep in a
-- long reply does not bring a turn into a pack. The recall backfill (meta key
-- memory_recall_backfill_v2) fills it for the turns indexed before.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_recall_full_fts USING fts5(
  terms,
  content='',
  contentless_delete=1,
  detail=none,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS memory_recall_docs_full_ad AFTER DELETE ON memory_recall_docs BEGIN
  DELETE FROM memory_recall_full_fts WHERE rowid = old.id;
END;
