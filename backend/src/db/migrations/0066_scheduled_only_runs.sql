-- Scheduled-only jobs (visibility 'scheduled'): each run's thread stays in the
-- job's workspace but shows only on the Scheduled page.
-- nodes.scheduled_only_job_id names the job whose run made the thread; NULL is
-- an ordinary conversation (moving a run to its workspace clears it). Server-
-- owned like maintenance_job_id: graph snapshots cannot set or clear it.
-- Intentionally no FK: a deleted job's threads stay hidden until the scheduler
-- removes them.
ALTER TABLE scheduled_jobs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'workspace';
ALTER TABLE nodes ADD COLUMN scheduled_only_job_id TEXT;

-- Retention and the deleted-job sweep find a job's hidden threads.
CREATE INDEX IF NOT EXISTS idx_nodes_scheduled_only_job
  ON nodes (scheduled_only_job_id) WHERE scheduled_only_job_id IS NOT NULL;
