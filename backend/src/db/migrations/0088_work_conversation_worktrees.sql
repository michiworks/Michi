-- Design D18, Q26 (lane D, 2026-11-12): a work conversation Michi starts
-- (start_conversation, an applied conversation.start card) in a workspace
-- whose folder is a git repository runs on its own worktree and branch, so
-- its changes stay off the user's checkout. Every session of the node opens
-- in session_cwd (services/workConversationWorktree.ts). Server-owned: graph
-- snapshots never write it. The row goes with the node.
CREATE TABLE IF NOT EXISTS work_conversation_worktrees (
  node_id         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  worktree_path   TEXT NOT NULL,
  session_cwd     TEXT NOT NULL,
  branch          TEXT NOT NULL,
  repository_root TEXT NOT NULL,
  base_commit     TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
