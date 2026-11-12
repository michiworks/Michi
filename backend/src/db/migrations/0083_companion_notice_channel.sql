-- Companion notification channel:
-- which gate a desktop notice came through. NULL is the Companion's own gate
-- (every notice written before this, and every one of its own after);
-- 'chat' is a conversation's approval request, question or finished reply
-- that the backend sends while no Michi window is open
-- (services/companion/chatNotices.ts). The Companion's caps count only its
-- own, and a backlog folds only its own (services/companion/delivery.ts).
-- Purely additive, as 0064: a revert of the v2 code ignores the column.
ALTER TABLE companion_notices ADD COLUMN channel TEXT;
