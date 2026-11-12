-- Companion notification kind: what a conversation's ('chat') desktop notice is about:
-- 'approval', 'question' or 'reply'; NULL for the Companion's own notices
-- and for every notice written before this. An approval or a question no
-- longer waits once the backend that stored it has stopped, so the backend
-- that starts next withdraws the undelivered ones of those two kinds
-- (services/companion/delivery.ts withdrawChatRequestNotices) and keeps the
-- replies. Purely additive, as 0064 and 0065: a revert ignores the column.
ALTER TABLE companion_notices ADD COLUMN chat_kind TEXT;
