-- Michi Memory: the profile of the user (services/memory/userProfile.ts),
-- a short summary Michi rebuilds in the background from the user's active
-- user-scope memories and every memory pack pins as "About the user". It is
-- rebuilt by an automatic memory run (memory_extraction_runs, kind 'profile':
-- one direct structured call, or one memory_profile call), so it shares
-- extraction's lease, budget and pauses. Every line cites the memories it
-- rests on (id, row and version): a pack shows a line only while each memory
-- it cites is unchanged, and
-- removing a memory removes the lines citing it at once, so no text of a
-- removed memory stays here. Additive only: no CHECK changes and no table
-- rebuild.
CREATE TABLE IF NOT EXISTS memory_user_profiles (
  owner_user_id TEXT PRIMARY KEY,
  -- JSON [{ "topic": "…", "text": "…", "refs": [{ "id": "mem-…", "rowId": 12, "version": 1 }] }], in order.
  lines TEXT NOT NULL DEFAULT '[]',
  -- The language the lines are written in ('zh' or 'en'); NULL before the first build.
  language TEXT,
  -- Goes up with every rebuild: a session holding an older one is sent the new one.
  version INTEGER NOT NULL DEFAULT 0,
  -- The user scope's memory version (memory_scope_versions) the lines were built from; NULL before the first build.
  source_version INTEGER,
  built_at INTEGER,
  -- When the latest rebuild was planned: the next follows the cadence from here (extractionRun.profileRebuildDue).
  attempted_at INTEGER,
  -- Why the latest rebuild failed, or NULL.
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

-- What an automatic memory run does: 'extract' reads conversation turns
-- (memory_extract), 'profile' rebuilds the user's profile (memory_profile).
ALTER TABLE memory_extraction_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'extract';
