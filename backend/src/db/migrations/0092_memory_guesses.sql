-- Michi Memory, guesses (services/memory/guesses.ts): a pattern background consolidation noticed across two or more
-- of the owner's user-scope notes, which the user confirms (it becomes a note they saved) or rejects in Settings ›
-- Memory. A guess is never put in a memory pack or used as a fact. Additive only.
--
-- refs: the cited notes, a JSON array of {"id", "version"} (memories.id and the version cited).
-- fingerprint: the cited notes (their sorted ids, hashed): a guess on the same notes is never proposed again,
-- whatever its status. body_hash: extractionRepository.memoryBodyHash of the body. A rejected guess keeps both
-- and loses its body. memory_id: the note a confirmation saved. No foreign keys, like the other memory tables:
-- resets and owner purges delete these rows themselves.
CREATE TABLE IF NOT EXISTS memory_guesses (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  refs TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected')),
  fingerprint TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  memory_id TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_guesses_owner ON memory_guesses(owner_user_id, status, created_at);
