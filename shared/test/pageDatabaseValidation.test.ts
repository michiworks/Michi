import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { applyPageDatabaseOps, parsePageDatabaseOps, type PageDatabase } from '../src/pages/database';
import { isTargetMutation } from '../src/pages/types';

const base: PageDatabase = {
  id: 'db1', workspaceId: 'ws1', title: 'Release', revision: 1, updatedAt: 10,
  columns: [{ id: 'name', name: 'Name', type: 'text' }, { id: 'status', name: 'Status', type: 'select', options: [{ value: 'todo' }] }],
  views: [{ id: 'table', name: 'Table', type: 'table', config: { filters: [], match: 'all', sorts: [] }, position: 0 }],
  rows: [],
};

/** A database's schema as its history records it. */
const inHistory = ({ id, workspaceId, title, columns, views }: PageDatabase) =>
  isTargetMutation({ kind: 'database', op: 'replace', database: { id, workspaceId, title, columns, views } });

/** The ops as a write takes them: parsed, then applied. */
function write(database: PageDatabase, ops: unknown[]): PageDatabase {
  const parsed = parsePageDatabaseOps(ops, 'user');
  if (!parsed.ok) throw new Error(parsed.error);
  return applyPageDatabaseOps(database, parsed.ops, { actor: 'user', revision: database.revision + 1, now: 20, newId: (prefix) => `${prefix}-new` }).database;
}

describe('page database validation', () => {
  test('anything a write accepts, its history accepts', () => {
    const written = write(base, [
      { op: 'column.add', column: { id: 'pri', name: 'Priority', type: 'select', options: [{ value: 'high', label: 'High', color: 'red' }, { value: 'low' }] } },
      { op: 'column.add', column: { id: 'due', name: 'Due', type: 'date', width: 120 } },
      { op: 'option.add', id: 'status', option: { value: 'done', color: 'green' } },
      { op: 'view.save', view: { id: 'board', name: 'Board', type: 'board', config: { filters: [{ column: 'pri', op: 'is', value: 'high' }, { column: 'due', op: 'not-empty' }], match: 'any', sorts: [{ column: 'due', dir: 'desc' }], group: 'status', visible: ['name', 'pri'], date: 'due' } } },
    ]);
    assert.equal(inHistory(written), true);
  });

  test("a column's 101st option is refused on write, with the reason", () => {
    const full: PageDatabase = { ...base, columns: [base.columns[0]!, { ...base.columns[1]!, options: Array.from({ length: 100 }, (_, i) => ({ value: `o${i}` })) }] };
    assert.equal(inHistory(full), true);
    assert.throws(() => write(full, [{ op: 'option.add', id: 'status', option: { value: 'one more' } }]), /A column holds at most 100 options/);
    const roomy = write(base, [{ op: 'option.add', id: 'status', option: { value: 'done' } }]);
    assert.deepEqual(roomy.columns[1]!.options, [{ value: 'todo' }, { value: 'done' }]);
  });

  test('history still reads what older writes stored', () => {
    const legacy = {
      ...base,
      columns: [{ id: 'status', name: 'Status', type: 'select' as const, options: [{ value: 'todo' }, { value: 'todo' }] }],
      views: [{ id: 'table', name: 'Table', type: 'table' as const, position: 0, config: { filters: [], match: 'all' as const, sorts: [], date: '', component: 'old', code: 'return 1' } }],
    };
    assert.equal(inHistory(legacy as PageDatabase), true);
    assert.equal(parsePageDatabaseOps([{ op: 'view.save', view: { name: 'Table', type: 'table', config: { filters: [], match: 'all', sorts: [], code: 'return 1' } } }], 'user').ok, false);
    assert.equal(parsePageDatabaseOps([{ op: 'view.save', view: { name: 'Table', type: 'table', config: { filters: [], match: 'all', sorts: [], date: '' } } }], 'user').ok, false);
    assert.equal(parsePageDatabaseOps([{ op: 'column.update', id: 'status', patch: { options: [{ value: 'todo' }, { value: 'todo' }] } }], 'user').ok, false);
  });

  test('option colours are the database palette on both sides', () => {
    assert.equal(parsePageDatabaseOps([{ op: 'option.add', id: 'status', option: { value: 'x', color: 'pink' } }], 'user').ok, false);
    assert.equal(parsePageDatabaseOps([{ op: 'column.add', column: { name: 'Tag', type: 'select', options: [{ value: 'x', color: 'pink' }] } }], 'user').ok, false);
    assert.equal(inHistory({ ...base, columns: [{ id: 'status', name: 'Status', type: 'select', options: [{ value: 'x', color: 'pink' as 'red' }] }] }), false);
  });
});
