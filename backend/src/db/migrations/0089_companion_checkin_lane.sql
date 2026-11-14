-- The scheduler's check-in lane (unification D11, P6): one execution identity
-- per owner, a maintenance job in the assistant's workspace that the lane, not
-- the maintenance coordinator, starts. A row whose job is gone is made again.
CREATE TABLE IF NOT EXISTS companion_checkin_jobs (
  owner_user_id TEXT PRIMARY KEY DEFAULT 'local-user',
  job_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- P6a shadow: when the lane would have started a check-in while the
-- coordinator still starts them. Kind and time only: no titles, no text.
CREATE TABLE IF NOT EXISTS companion_checkin_shadow (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id TEXT NOT NULL DEFAULT 'local-user',
  kind TEXT NOT NULL,
  planned_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_companion_checkin_shadow_at ON companion_checkin_shadow(owner_user_id, planned_at);
