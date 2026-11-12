-- 0081_context_tombstones: an artifact deleted once stays deleted.
--
-- deleteContext (the Artifacts drawer's Delete via context.delete, and
-- delete_artifact) hard-deletes the contexts row and records its id here.
-- saveContext and the context.upsert command skip a tombstoned id, so a stale
-- write (another window's snapshot, a request still in flight, a replayed
-- artifact_saved) cannot bring the artifact back; the command result names it
-- in goneContextIds so the sender drops it too. Every way to create an
-- artifact makes a new id, so a same-name save after a delete is unaffected.
--
-- A table of its own, not a deleted_at column on contexts: a soft-deleted row
-- would still hold UNIQUE(workspace_id, name), which SQLite can only drop by
-- rebuilding the table, and every read of contexts would need a filter.
--
-- runTombstoneGc (dbRepository.ts) drops rows older than TOMBSTONE_TTL_MS
-- (90 days), as it does node and workspace tombstones.
CREATE TABLE IF NOT EXISTS context_tombstones (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_context_tombstones_deleted ON context_tombstones(deleted_at);
