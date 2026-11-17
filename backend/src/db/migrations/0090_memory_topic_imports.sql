-- Michi Memory: imported notes no longer take their file's name as topic (a
-- name names one note, not an area: 50 topics for 97 notes, 28 of them
-- holding one). Clear the ones imports set, so the topic pass
-- (services/memory/memoryTopics.ts) files them under broad topics. Its cursor
-- starts at 0, so it reads every untagged memory once.
UPDATE memories SET topic = NULL WHERE import_source IS NOT NULL;
