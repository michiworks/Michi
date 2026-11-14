-- Pause Michi (services/michiPause.ts): `paused` stays the pause until the user
-- resumes; paused_until is a pause that ends by itself at that time.
ALTER TABLE meta_agent_maintenance_state ADD COLUMN paused_until INTEGER;

-- What a check-in's turn used (CompanionRunUsage JSON), recorded before its node is discarded.
ALTER TABLE companion_runs ADD COLUMN usage_json TEXT;
