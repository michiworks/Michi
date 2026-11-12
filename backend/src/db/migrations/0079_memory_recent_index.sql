-- The memory pack's Recent conversations (services/memory/recentConversations.ts)
-- reads, for each conversation of the workspace, its newest turn document a
-- person typed that recall shows, and then its few newest ones: an index walk
-- that stops there, however long the conversation, and leaves out hidden
-- documents (Don't recall, a conversation that stopped learning, Delete all
-- memories), which keep their rows.
CREATE INDEX IF NOT EXISTS idx_memory_recall_docs_node_turns ON memory_recall_docs(node_id, at)
  WHERE doc_kind = 'turn' AND hidden = 0;
