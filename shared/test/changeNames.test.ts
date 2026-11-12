import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pageBlockName, pageRowName, type PageBlockInput } from '../src/index';

describe('change names', () => {
  test('a block goes by its title or heading, else its first words without Markdown marks', () => {
    const cases: Array<[PageBlockInput, string]> = [
      [{ type: 'heading', text: '  Risks ' }, 'Risks'],
      [{ type: 'markdown', text: '\n## 本周重点\n- a' }, '本周重点'],
      [{ type: 'markdown', text: '- **Ship** the `release`' }, 'Ship the release'],
      [{ type: 'markdown', text: '1) ~~old~~ new' }, 'old new'],
      [{ type: 'callout', title: '预算', text: '已花 ¥9,800' }, '预算'],
      [{ type: 'callout', text: '首屏\n2.1s' }, '首屏 2.1s'],
      [{ type: 'checklist', title: 'Packing', items: [{ text: 'Socks', done: false }] }, 'Packing'],
      [{ type: 'checklist', items: [{ text: 'Socks', done: false }] }, ''],
      [{ type: 'metrics', items: [{ label: 'Spend', value: '¥9,800' }] }, ''],
      [{ type: 'database-ref', databaseId: 'db1' }, ''],
      [{ type: 'table', title: 'Hotels', columns: ['Name'], rows: [['Kanra']] }, 'Hotels'],
    ];
    for (const [block, name] of cases) assert.equal(pageBlockName(block), name, JSON.stringify(block));
  });

  test('a name is cut at 24 characters by default, or where asked', () => {
    const long = { type: 'heading' as const, text: 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmn' };
    assert.equal(pageBlockName(long), 'abcdefghijklmnopqrstuvwx…');
    assert.equal(pageBlockName(long, 40), 'abcdefghijklmnopqrstuvwxyz0123456789abcd…');
    assert.equal(pageRowName({ name: 'abcdefghijklmnopqrstuvwxyz' }, 'name'), 'abcdefghijklmnopqrstuvwx…');
  });

  test('a row goes by its title column, whatever order its cells were written in, else its first text', () => {
    assert.equal(pageRowName({ status: 'doing', task: 'Write the spec' }, 'task'), 'Write the spec');
    assert.equal(pageRowName({ status: 'doing', task: '  ' }, 'task'), 'doing');
    assert.equal(pageRowName({ status: 'doing', task: 'Write the spec' }, null), 'doing');
    assert.equal(pageRowName({ count: 3, tags: ['a'], due: { start: '2026-11-10' } }, 'gone'), '');
  });
});
