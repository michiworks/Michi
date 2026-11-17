-- The morning brief is gone (2026-11-17): Today says in one line what waits on
-- the user, so a second daily summary of the same items had nothing left to
-- say. Nothing writes companion_briefs any more, and no code reads it, so the
-- table goes with it; the posts the briefs left in the conversation stay
-- (companion_runs keeps kind 'brief'), and so does the agent's own history.
DROP TABLE IF EXISTS companion_briefs;

-- Instead of the brief, a check-in can raise one Today item into "Waiting on
-- you" with a reason (companion_update_item action 'raise',
-- CompanionItemDto.raised): the one way something Michi merely read, such as a
-- mail, reaches the user without a model turn speaking. Like a rating it
-- belongs to the version it was given on (raised_version), so the next change
-- to the object drops it.
ALTER TABLE companion_items ADD COLUMN raised_reason TEXT;
ALTER TABLE companion_items ADD COLUMN raised_version TEXT;
ALTER TABLE companion_items ADD COLUMN raised_at INTEGER;
