-- Suggestions that can no longer be accepted stop waiting; a dismissed one can still be reopened.

-- A block suggestion whose block changed after it was made fails on Accept.
UPDATE page_changes SET proposal_state = 'dismissed', resolved_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE proposal_state = 'pending' AND page_id IS NOT NULL
  AND base_rev <> COALESCE((
    SELECT json_extract(b.value, '$.rev') FROM pages p, json_each(p.blocks) b
    WHERE p.id = page_changes.page_id AND json_extract(b.value, '$.id') = json_extract(page_changes.target, '$.blockId')
  ), 1);

-- On a home the Meta agent now updates the blocks an agent wrote directly, so their suggestions are dismissed.
UPDATE page_changes SET proposal_state = 'dismissed', resolved_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE proposal_state = 'pending'
  AND EXISTS (
    SELECT 1 FROM pages p, json_each(p.blocks) b
    WHERE p.id = page_changes.page_id AND p.role IS NOT NULL
      AND json_extract(b.value, '$.id') = json_extract(page_changes.target, '$.blockId')
      AND json_array_length(COALESCE(json_extract(b.value, '$.sources'), '[]')) > 0
  );
