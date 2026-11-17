-- Michi Memory, validity (services/memory/validity.ts). Additive only; no backfill.

-- When the memory stops being true (ms epoch; it is past once now reaches it), as automatic extraction read it from
-- what the user said (valid_until: the next local midnight after the last day) or the user set it in Settings ›
-- Memory; NULL: no end. Memory packs leave out a memory past it; memory_search shows it only with history.
ALTER TABLE memories ADD COLUMN valid_until INTEGER;
-- When a reply last used the memory, as reply sources attribute it (memory_turn_sources), ms epoch; NULL: never.
-- Written without a version or updated_at change.
ALTER TABLE memories ADD COLUMN last_used_at INTEGER;
-- When the user last confirmed it (an edit in Settings › Memory, saving the same note again, memory_update with
-- userAsked, extraction finding it already stored), ms epoch; NULL: never. Written like last_used_at.
ALTER TABLE memories ADD COLUMN last_confirmed_at INTEGER;
