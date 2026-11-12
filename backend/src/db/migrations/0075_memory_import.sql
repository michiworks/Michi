-- One-way import of the runtimes' own memories into Michi Memory
-- (services/memory/nativeMemoryImport.ts): Claude Code's auto memory, Codex
-- memories and Kiro's. Michi only reads their files. Additive only: no CHECK
-- changes and no table rebuild.

-- Set on a memory Michi imported: the runtime whose memory it came from
-- ('claude', 'codex', 'kiro') and the item there: '<project>/<file>' (Claude),
-- 'memories/<file>#<section>' (Codex) or '<identity>/memories.db#<id>' (Kiro),
-- with '#<n>' added for a later part of a note that had to be split. NULL for
-- every other memory.
ALTER TABLE memories ADD COLUMN import_source TEXT;
ALTER TABLE memories ADD COLUMN import_ref TEXT;

-- One row per imported item and scope (workspace_id '' is the user scope),
-- kept after its memory is gone: a memory deleted in Michi, by whatever path,
-- is not imported again. memory_id NULL: the owner already had that body when
-- the item was imported, so nothing was stored. body_hash: the normalized body
-- last imported (memoryBodyHash); version: the memory's version then, so a
-- memory changed in Michi since is Michi's own and the import leaves it alone.
-- No memory text is kept here. No foreign keys, like the extraction tables:
-- workspace and owner purges delete these rows themselves.
CREATE TABLE IF NOT EXISTS memory_import_items (
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  import_source TEXT NOT NULL,
  import_ref TEXT NOT NULL,
  memory_id TEXT,
  body_hash TEXT NOT NULL,
  version INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_user_id, workspace_id, import_source, import_ref)
);
