-- Multi-model runs (services/multiModel/): a chat agent proposes 1-5 branches on
-- other runtimes/models; on the user's Start the backend runs them, review rounds
-- and a synthesis in the caller. The run's UI snapshot is a workflow run with
-- runtime 'michi' (services/workflowRunHub.ts); the orchestrator's own state is
-- multi_model_runs / multi_model_turns.

-- 1. workflow_runs: widen the runtime CHECK to 'michi'. SQLite cannot alter a
-- CHECK, so the table is rebuilt with the same columns, keys and index.
DROP TABLE IF EXISTS workflow_runs_next;
CREATE TABLE workflow_runs_next (
  id              TEXT PRIMARY KEY,
  owner_user_id   TEXT NOT NULL,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id         TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  runtime         TEXT NOT NULL CHECK (runtime IN ('claude', 'kiro', 'michi')),
  native_id       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'failed', 'cancelled')),
  run_json        TEXT NOT NULL CHECK (json_valid(run_json) AND json_extract(run_json, '$.version') = 1),
  started_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (owner_user_id, runtime, native_id)
);
-- Foreign keys are on here: a row whose workspace is gone is dropped and a
-- dangling node_id becomes NULL (what ON DELETE SET NULL would have done), so
-- stale rows from a database that once ran without foreign keys cannot abort
-- the migration.
INSERT INTO workflow_runs_next (id, owner_user_id, workspace_id, node_id, runtime, native_id, status, run_json, started_at, updated_at)
  SELECT id, owner_user_id, workspace_id,
         (SELECT nodes.id FROM nodes WHERE nodes.id = workflow_runs.node_id),
         runtime, native_id, status, run_json, started_at, updated_at
  FROM workflow_runs
  WHERE workspace_id IN (SELECT id FROM workspaces);
DROP TABLE workflow_runs;
ALTER TABLE workflow_runs_next RENAME TO workflow_runs;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workspace ON workflow_runs(owner_user_id, workspace_id, updated_at DESC);

-- 2. The orchestrator's durable state, one row per run. id = the workflow run id
-- (wfr_…); native_id = mm_<uuid>. plan_json: the plan (threads, prompts, models,
-- review rounds); state_json: per thread per step status, child node ids, turn
-- ids and outcomes, synthesis. revision guards concurrent writes (compare-and-set).
CREATE TABLE IF NOT EXISTS multi_model_runs (
  id                TEXT PRIMARY KEY,
  native_id         TEXT NOT NULL UNIQUE,
  owner_user_id     TEXT NOT NULL,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  caller_node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  caller_turn_id    TEXT,
  caller_message_id TEXT,
  ask_message_id    TEXT,
  status            TEXT NOT NULL CHECK (status IN ('proposed', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  plan_json         TEXT NOT NULL CHECK (json_valid(plan_json)),
  state_json        TEXT NOT NULL CHECK (json_valid(state_json)),
  revision          INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_multi_model_runs_caller ON multi_model_runs (caller_node_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_multi_model_runs_open ON multi_model_runs (status) WHERE status IN ('proposed', 'running');

-- 3. Every turn a run requests, keyed by turn id (attention, Stop, restart
-- recovery look turns up by id). Written before the turn is started.
CREATE TABLE IF NOT EXISTS multi_model_turns (
  turn_id     TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES multi_model_runs(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,
  thread_key  TEXT,
  role        TEXT NOT NULL CHECK (role IN ('answer', 'review', 'synthesis', 'addendum')),
  round       INTEGER NOT NULL DEFAULT 0 CHECK (round >= 0),
  attempt     INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  outcome     TEXT CHECK (outcome IN ('completed', 'failed', 'cancelled', 'stopped', 'interrupted', 'withdrawn')),
  error       TEXT,
  created_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_multi_model_turns_run ON multi_model_turns (run_id);

-- 4. Child markers. multi_model_run_id: the run that created this branch (one
-- level: such a node may not propose a run; labels). fresh_context = 1: the
-- branch inherits no parent history anywhere the backend would otherwise inject
-- it (branchBoundary.ts, routes/michi.ts ensure-session and runtime switch,
-- chatManager restore, planSnapshot). Both are server-owned; graph snapshots never write them.
ALTER TABLE nodes ADD COLUMN multi_model_run_id TEXT;
ALTER TABLE nodes ADD COLUMN fresh_context INTEGER NOT NULL DEFAULT 0 CHECK (fresh_context IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_nodes_multi_model_run ON nodes (multi_model_run_id) WHERE multi_model_run_id IS NOT NULL;
