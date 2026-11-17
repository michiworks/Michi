-- A chat's speed tier (Codex: Ultrafast): a tier id its model lists, or NULL
-- for standard. Server-owned like ultracode: written only by
-- PUT /nodes/:nodeId/service-tier, never by graph snapshots. New and branched
-- chats start at standard.
ALTER TABLE nodes ADD COLUMN service_tier TEXT;
