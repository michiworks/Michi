-- send_to_thread with wake (services/threadMessageWakeStore.ts): when the
-- target thread's turn for a message ends, its reply starts a turn in the
-- sending thread. One row per woken message, written before the message is
-- delivered and keyed by the target turn it starts. requested_turn_id is the
-- sender's reply turn, derived from target_turn_id, so a delivery retried
-- after a restart returns the turn that already began instead of a second.
--
-- state: pending (the target has not finished, or a delivery is left for the
-- next startup), delivering (claimed once: the reply turn is being started),
-- delivered (the reply turn began), undeliverable (detail says why: the
-- sender was gone, archived or in the trash, a Stop cancelled it
-- (caller_cancelled, target_cancelled), a restart cut the answer short or
-- the message never began (interrupted, not_started), or the delivery failed
-- `attempts` times). hop: the reply turn's distance in agent hand-offs from
-- the last turn a person started (loop guard). Startup deletes settled rows
-- after 14 days.
CREATE TABLE IF NOT EXISTS thread_message_wakes (
  target_turn_id    TEXT PRIMARY KEY,
  requested_turn_id TEXT NOT NULL UNIQUE,
  owner_user_id     TEXT,
  workspace_id      TEXT NOT NULL,
  caller_node_id    TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  caller_turn_id    TEXT,
  target_node_id    TEXT NOT NULL,
  hop               INTEGER NOT NULL CHECK (hop >= 0),
  state             TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'undeliverable')),
  detail            TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  delivered_at      INTEGER
);

-- Startup recovery reads the open rows only.
CREATE INDEX IF NOT EXISTS idx_thread_message_wakes_open
  ON thread_message_wakes (target_turn_id) WHERE state IN ('pending', 'delivering');

-- Deleting a node finds its rows for the cascade.
CREATE INDEX IF NOT EXISTS idx_thread_message_wakes_caller_node
  ON thread_message_wakes (caller_node_id);

-- A Stop finds the wakes its turn asked for.
CREATE INDEX IF NOT EXISTS idx_thread_message_wakes_caller_turn
  ON thread_message_wakes (caller_turn_id) WHERE caller_turn_id IS NOT NULL;
