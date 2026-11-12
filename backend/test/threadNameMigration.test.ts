import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test("a thread's name folds into its root's title and is dropped", (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE trees (id TEXT PRIMARY KEY, root_node_id TEXT, name TEXT);
    INSERT INTO nodes VALUES ('renamed', '问候与开场'), ('untitled', NULL), ('same', 'Same'), ('plain', 'Plain'), ('blank', 'Blank');
    INSERT INTO trees VALUES ('t1', 'renamed', ' Memory workflow '), ('t2', 'untitled', 'Named'), ('t3', 'same', 'Same'),
      ('t4', 'plain', NULL), ('t5', 'blank', '   ');
  `);
  db.exec(readFileSync(join(__dirname, '../src/db/migrations/0070_thread_name_is_root_title.sql'), 'utf8'));
  const titles = db.prepare('SELECT id, title FROM nodes ORDER BY id').all().map((row) => [row.id, row.title]);
  assert.deepEqual(titles, [['blank', 'Blank'], ['plain', 'Plain'], ['renamed', 'Memory workflow'], ['same', 'Same'], ['untitled', 'Named']]);
  assert.deepEqual(db.prepare('SELECT id FROM trees WHERE name IS NOT NULL').all(), []);
});
