-- Indexes for Pages upkeep's overview (services/metaAgent/overview.ts), which runs on the request thread. On a
-- data.db with 342 plans, 2,510 receipts and 286 home summaries it took about 1.8 s, and 0.1 s with these:
-- - planEntries counts each plan's written and proposed receipts. With no index on plan_id each count scanned
--   every receipt and its JSON columns. The index also serves the ON DELETE CASCADE from a plan.
-- - summaryEntries finds, for each summary, the settled one before it (MAX(created_at)), and the workspace homes
--   changed in between (page_changes by page and created_at). With no index holding created_at, the first read
--   every summary row and the second every change of each home. The new owner index replaces its prefix.
CREATE INDEX IF NOT EXISTS idx_page_maintenance_receipts_plan ON page_maintenance_receipts(plan_id, outcome);
DROP INDEX IF EXISTS idx_meta_agent_home_runs_owner;
CREATE INDEX IF NOT EXISTS idx_meta_agent_home_runs_owner_created ON meta_agent_home_runs(owner_user_id, kind, state, created_at);
CREATE INDEX IF NOT EXISTS idx_page_changes_page_created ON page_changes(page_id, created_at);
