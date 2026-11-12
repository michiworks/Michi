-- Ultracode for a chat (Claude): standing multi-agent orchestration, where the
-- agent runs a workflow for every substantive task. Server-owned like
-- permission_mode: written only by PUT /nodes/:nodeId/ultracode, never by
-- graph snapshots. New and branched chats start with it off.
ALTER TABLE nodes ADD COLUMN ultracode INTEGER NOT NULL DEFAULT 0 CHECK (ultracode IN (0, 1));
