-- Automatic memory extraction v2 (services/memory/extractionV2.ts): an
-- execution shows its source turns inline in the prompt and the model answers
-- with one memory_extract call. Additive only: no CHECK changes and no table
-- rebuild.

-- payload: the validated memory_extract arguments, staged until the run
-- settles (extractionRun.settleMemoryExtractionRun commits them with the
-- cursor). Cleared whenever the run finishes, committed or not, so no memory
-- text stays here.
ALTER TABLE memory_extraction_runs ADD COLUMN payload TEXT;
-- The existing memories the prompt listed, as JSON
-- [{ "ref": "m:…", "memoryId": "mem-…" }]: an "update" may target only these.
ALTER TABLE memory_extraction_runs ADD COLUMN related_memories TEXT;

-- The retired four-tool protocol staged candidates one memory_propose call at
-- a time; nothing commits them any more, so their text goes now.
UPDATE memory_extraction_candidates SET body = NULL, state = 'dropped',
  drop_reason = COALESCE(drop_reason, 'run_not_committed')
  WHERE state = 'staged';
