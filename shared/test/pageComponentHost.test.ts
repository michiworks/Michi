import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PAGE_BLOCK_CATALOG } from '../src/pages/blockCatalog';
import { parsePageBlockInput } from '../src/pages/blocks';
import { PAGE_COMPONENT_LIMITS, parsePageComponentHostConfig } from '../src/pages/components';
import { parsePageDatabaseOps } from '../src/pages/database';

const viewSave = (config: Record<string, unknown>) => parsePageDatabaseOps([{ op: 'view.save', view: { id: 'v', name: 'Chart', type: 'custom', config: { filters: [], match: 'all', sorts: [], ...config } } }], 'user').ok;

describe('a component host config', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ...[79, 80, 1_600, 1_601, 100.5].map((height): [string, Record<string, unknown>] => [`height ${height}`, { height }]),
    ...[0, 1, 1.5].map((pinnedVersion): [string, Record<string, unknown>] => [`pinnedVersion ${pinnedVersion}`, { pinnedVersion }]),
    ['no componentId', { componentId: '' }],
  ];
  for (const [name, extra] of cases) {
    test(`page blocks and custom views agree with the shared rule: ${name}`, () => {
      const config = { componentId: 'chart', props: {}, ...extra };
      const expected = parsePageComponentHostConfig(config) !== null;
      assert.equal(parsePageBlockInput({ type: 'component', ...config }) !== null, expected, 'page block');
      assert.equal(viewSave(config), expected, 'custom view');
    });
  }

  test('the height range is the limits’ range on every path', () => {
    const at = (height: number) => parsePageComponentHostConfig({ componentId: 'chart', props: {}, height }) !== null;
    assert.deepEqual([PAGE_COMPONENT_LIMITS.heightMin - 1, PAGE_COMPONENT_LIMITS.heightMin, PAGE_COMPONENT_LIMITS.heightMax, PAGE_COMPONENT_LIMITS.heightMax + 1].map(at), [false, true, true, false]);
    const height = (PAGE_BLOCK_CATALOG.component.schema as { properties: { height: { minimum: number; maximum: number } } }).properties.height;
    assert.deepEqual([height.minimum, height.maximum], [PAGE_COMPONENT_LIMITS.heightMin, PAGE_COMPONENT_LIMITS.heightMax]);
  });

  test('a page block keeps its keys in order', () => {
    assert.equal(JSON.stringify(parsePageBlockInput({ height: 200, props: { a: 1 }, pinnedVersion: 2, componentId: 'chart', type: 'component' })),
      JSON.stringify({ type: 'component', componentId: 'chart', pinnedVersion: 2, props: { a: 1 }, height: 200 }));
  });
});
