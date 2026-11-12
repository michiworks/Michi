/**
 * The schema of a fresh data.db after every migration, compared with a committed
 * snapshot, so that migration cleanup, legacy-column removal or a dbRepository
 * split cannot change it unnoticed. migrate.test.ts checks only which migrations
 * applied.
 *
 * initDb runs the in-process V1..V14 steps and then every SQL file; that is how
 * every real data.db is made, and the snapshot is its schema. The SQL files alone,
 * on a database those steps never touched, must reach the same schema except for
 * the column order of the tables named below.
 *
 * After adding a migration, regenerate the snapshot; its diff must contain only
 * that migration's objects:
 *   MICHI_UPDATE_SCHEMA_GOLDEN=1 MICHI_GOLDEN_WRITE_CONFIRM=1 npm run test:file -w backend -- test/schemaSnapshot.test.ts
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, initDb } from '../src/services/db';
import { runMigrations } from '../src/services/migrate';

const FIXTURE = path.join(__dirname, 'fixtures', 'dataDbSchema.golden.txt');
const UPDATE = process.env.MICHI_UPDATE_SCHEMA_GOLDEN === '1';

/**
 * 0000_baseline.sql declares nodes' columns in another order than V1's CREATE
 * plus the V2..V14 ALTERs (the session columns come before created_at), so a
 * database made by the SQL files alone orders them differently. A migration that
 * rebuilds nodes with INSERT ... SELECT * would put values in the wrong columns
 * on one of the two.
 */
const SQL_FILES_ONLY_COLUMN_ORDER_DIFFERS = ['nodes'];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

type Row = Record<string, unknown>;

function rows(db: DatabaseSync, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The stored CREATE text, one whitespace-collapsed line per source line. */
function sqlLines(sql: unknown): string[] {
  if (typeof sql !== 'string') return [];
  return sql.split('\n').map((line) => line.trim().replace(/\s+/g, ' ')).filter(Boolean).map((line) => `  | ${line}`);
}

function columnLine(column: Row, withPosition: boolean): string {
  const flags = [
    column.notnull ? 'not null' : '',
    column.pk ? `pk ${column.pk as number}` : '',
    column.dflt_value !== null ? `default ${column.dflt_value as string}` : '',
  ].filter(Boolean);
  const position = withPosition ? `${column.cid as number} ` : '';
  return `  column ${position}${column.name as string} ${(column.type as string) || '(untyped)'}${flags.map((flag) => `; ${flag}`).join('')}`;
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return rows(db, `PRAGMA table_info(${quoted(table)})`).map((column) => column.name as string);
}

/**
 * sqlite_master with what PRAGMA table_info, index_list/index_info and
 * foreign_key_list report, grouped by table. Rows (the migration ledger
 * included) are left out: this is the shape, not the content.
 */
function describeSchema(db: DatabaseSync, options: { columnOrder: boolean }): string {
  const out: string[] = [];
  const objects = rows(db, `
    SELECT type, name, tbl_name, sql FROM sqlite_master
     ORDER BY tbl_name, CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name
  `);
  for (const object of objects) {
    const type = object.type as string;
    const name = object.name as string;
    const table = object.tbl_name as string;
    if (type === 'index') {
      const listed = rows(db, `PRAGMA index_list(${quoted(table)})`).find((index) => index.name === name)!;
      const columns = rows(db, `PRAGMA index_info(${quoted(name)})`).map((column) => (column.name as string | null) ?? '(expression)');
      out.push(`index ${name} on ${table}${listed.unique ? '; unique' : ''}; origin ${listed.origin as string}${listed.partial ? '; partial' : ''} (${columns.join(', ')})`);
      out.push(...sqlLines(object.sql));
      continue;
    }
    out.push(type === 'table' || type === 'view' ? `${type} ${name}` : `${type} ${name} on ${table}`);
    if (type !== 'table') {
      out.push(...sqlLines(object.sql));
      continue;
    }
    // The CREATE text lists the columns in their order, so it is compared only with the order.
    if (options.columnOrder) out.push(...sqlLines(object.sql));
    const columns = rows(db, `PRAGMA table_info(${quoted(name)})`);
    if (!options.columnOrder) columns.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const column of columns) out.push(columnLine(column, options.columnOrder));
    for (const key of rows(db, `PRAGMA foreign_key_list(${quoted(name)})`)) {
      out.push(`  foreign key ${key.id as number}.${key.seq as number} ${key.from as string} -> ${key.table as string}(${(key.to as string | null) ?? '(primary key)'}); on update ${key.on_update as string}; on delete ${key.on_delete as string}; match ${key.match as string}`);
    }
  }
  return `${out.join('\n')}\n`;
}

function migratedByInitDb(): DatabaseSync {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-schema-snapshot-'));
  const previous = process.env.MICHI_DATA_DIR;
  process.env.MICHI_DATA_DIR = dataDir;
  closeDb();
  cleanups.push(() => {
    closeDb();
    if (previous === undefined) delete process.env.MICHI_DATA_DIR;
    else process.env.MICHI_DATA_DIR = previous;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return initDb();
}

function migratedBySqlFilesOnly(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  runMigrations(db, path.join(__dirname, '../src/db/migrations'));
  return db;
}

/** Each line prefixed with the object it describes, so a changed line names its table. */
function qualifiedLines(schema: string): string[] {
  let object = '';
  return schema.split('\n').filter(Boolean).map((line) => (line.startsWith(' ') ? `${object} ::${line}` : (object = line)));
}

/** Lines only in `expected` (-) or only in `actual` (+): a readable diff of two descriptions. */
function changedLines(actual: string, expected: string): string[] {
  const actualLines = qualifiedLines(actual);
  const expectedLines = qualifiedLines(expected);
  const inActual = new Set(actualLines);
  const inExpected = new Set(expectedLines);
  return [
    ...expectedLines.filter((line) => !inActual.has(line)).map((line) => `- ${line}`),
    ...actualLines.filter((line) => !inExpected.has(line)).map((line) => `+ ${line}`),
  ];
}

function assertSameSchema(actual: string, expected: string, message: string): void {
  assert.deepEqual(changedLines(actual, expected), [], message);
  assert.equal(actual, expected, `${message} (same lines, another order)`);
}

test('a fresh data.db has the committed schema', () => {
  const actual = describeSchema(migratedByInitDb(), { columnOrder: true });
  if (UPDATE) fs.writeFileSync(FIXTURE, actual);
  assert.ok(fs.existsSync(FIXTURE), `missing ${FIXTURE}; regenerate it as the header of this file says`);
  assertSameSchema(actual, fs.readFileSync(FIXTURE, 'utf8'), 'schema differs from the snapshot; regenerate it only for an intended migration');
});

test('the SQL migrations alone reach the same schema, column order aside', () => {
  const initDbSchema = migratedByInitDb();
  const sqlFilesOnly = migratedBySqlFilesOnly();

  assertSameSchema(
    describeSchema(sqlFilesOnly, { columnOrder: false }),
    describeSchema(initDbSchema, { columnOrder: false }),
    'the SQL files alone reach another schema than initDb',
  );
  const tables = (rows(sqlFilesOnly, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((row) => row.name as string);
  const reordered = tables.filter((table) => columnNames(sqlFilesOnly, table).join() !== columnNames(initDbSchema, table).join());
  assert.deepEqual(reordered, SQL_FILES_ONLY_COLUMN_ORDER_DIFFERS);
});
