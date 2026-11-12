-- A thread has one name: its root conversation's title. Renaming a thread
-- renames that conversation (frontend renameTree), so a name stored apart in
-- trees.name, which the UI showed first, is folded into the root's title and
-- dropped. Readers keep falling back to the root's title when it is NULL.
UPDATE nodes
SET title = (
  SELECT TRIM(t.name) FROM trees t
  WHERE t.root_node_id = nodes.id AND TRIM(COALESCE(t.name, '')) <> ''
  LIMIT 1
)
WHERE id IN (SELECT root_node_id FROM trees WHERE TRIM(COALESCE(name, '')) <> '');

UPDATE trees SET name = NULL WHERE name IS NOT NULL;
