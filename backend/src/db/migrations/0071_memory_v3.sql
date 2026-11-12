-- Michi Memory v3: memory is on for everyone and nothing waits for approval
-- (services/memory owns every query). Additive only: no CHECK changes and no
-- table rebuild.
--
-- An owner without a memory_settings row now uses 'auto'; a stored 'explicit'
-- (retired) counts as 'auto' and startup rewrites it once
-- (extractionService.migrateRetiredExplicitMode). 'pending' rows come only
-- from older versions; startup activates them once (activateLegacyPending.ts).

-- Search aliases for recall (both languages, synonyms, entities), one per
-- line; '' when there are none.
ALTER TABLE memories ADD COLUMN keywords TEXT NOT NULL DEFAULT '';
-- When the event the memory describes happens or happened (ms epoch); NULL
-- when it describes no dated event.
ALTER TABLE memories ADD COLUMN event_at INTEGER;
-- When the user said it (ms epoch). Rows older than this column take their
-- created_at; new rows default to it in the service.
ALTER TABLE memories ADD COLUMN observed_at INTEGER;
UPDATE memories SET observed_at = created_at WHERE observed_at IS NULL;
-- Whether a turn already saved a memory (the explicit remember guarantee).
CREATE INDEX IF NOT EXISTS idx_memories_owner_source_turn ON memories(owner_user_id, source_turn_id)
  WHERE source_turn_id IS NOT NULL;

-- Recall index: one document per memory (doc_kind 'memory', ref_id the memory
-- id) and per completed human turn (doc_kind 'turn', ref_id the turn id).
-- at: the source time (ms epoch). snippet: the text a recall result shows.
-- keys: keyphrases added later (for example by extraction), one per line.
-- active 0: kept for history (a superseded memory), left out of default recall.
-- No foreign keys, like the extraction tables: workspace and owner purges
-- delete these rows themselves.
CREATE TABLE IF NOT EXISTS memory_recall_docs (
  id INTEGER PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT,
  doc_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  node_id TEXT,
  turn_id TEXT,
  at INTEGER NOT NULL,
  title TEXT,
  snippet TEXT NOT NULL,
  keys TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_recall_docs_ref ON memory_recall_docs(doc_kind, ref_id);
CREATE INDEX IF NOT EXISTS idx_memory_recall_docs_owner ON memory_recall_docs(owner_user_id, doc_kind, at);
CREATE INDEX IF NOT EXISTS idx_memory_recall_docs_workspace ON memory_recall_docs(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_recall_docs_node ON memory_recall_docs(node_id) WHERE node_id IS NOT NULL;

-- Contentless FTS keyed by memory_recall_docs.id (rowid). The app writes
-- pre-segmented, space-joined distinct terms (services/memory/memoryTerms.ts:
-- CJK bigrams, latin words, numbers, identifiers), so unicode61 only splits
-- on the spaces, and searches one term at a time. contentless_delete=1 lets a
-- row be deleted or replaced by rowid without the terms it was indexed with;
-- detail=none stores no positions (no phrase queries), about a quarter of the
-- size.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_recall_fts USING fts5(
  terms,
  content='',
  contentless_delete=1,
  detail=none,
  tokenize='unicode61 remove_diacritics 2'
);

-- A deleted document leaves no index entry, whoever deletes it.
CREATE TRIGGER IF NOT EXISTS memory_recall_docs_ad AFTER DELETE ON memory_recall_docs BEGIN
  DELETE FROM memory_recall_fts WHERE rowid = old.id;
END;

-- A conversation that is purged (Trash emptied, workspace deleted; its messages
-- go at once) or deleted takes its turn documents with it, whichever path does
-- it. Memories saved from it are the user's and stay.
CREATE TRIGGER IF NOT EXISTS memory_recall_docs_node_purged AFTER UPDATE OF purged_at ON nodes
WHEN new.purged_at IS NOT NULL
BEGIN
  DELETE FROM memory_recall_docs WHERE doc_kind = 'turn' AND node_id = new.id;
END;
CREATE TRIGGER IF NOT EXISTS memory_recall_docs_node_ad AFTER DELETE ON nodes BEGIN
  DELETE FROM memory_recall_docs WHERE doc_kind = 'turn' AND node_id = old.id;
END;
-- A conversation moved to another workspace is searched there.
CREATE TRIGGER IF NOT EXISTS memory_recall_docs_node_moved AFTER UPDATE OF workspace_id ON nodes
WHEN new.workspace_id IS NOT old.workspace_id
BEGIN
  UPDATE memory_recall_docs SET workspace_id = new.workspace_id WHERE doc_kind = 'turn' AND node_id = new.id;
END;
