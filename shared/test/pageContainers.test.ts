import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PAGE_BLOCK_CATALOG, PAGE_CONTAINER_LIMITS as LIMITS, TOP_LEVEL_ONLY_BLOCK_TYPES,
  mapPageChildBlocks, pageBlockProblem, pageChildBlockLists, pageSegmentSources, parsePageBlockInput, type PageBlockInput,
} from '../src/pages';

const md = (text = 'x') => ({ type: 'markdown', text });
const toggle = (blocks: unknown[]) => ({ type: 'toggle', title: 'T', blocks });
const TOP_LEVEL_ONLY: Record<string, object> = {
  'database-ref': { type: 'database-ref', databaseId: 'db-1' },
  'page-link': { type: 'page-link', pageId: 'pg-1' },
  component: { type: 'component', componentId: 'c-1', props: {} },
  threads: { type: 'threads', nodeIds: ['n-1'] },
  conflict: PAGE_BLOCK_CATALOG.conflict.example!,
  'home-section': { type: 'home-section', section: 'waiting' },
  view: { type: 'view', viewId: 'v', title: 'V', blockIds: ['b'] },
};

test('a container slot holds at most 20 blocks', () => {
  assert.ok(parsePageBlockInput(toggle(Array.from({ length: 20 }, () => md()))));
  const over = toggle(Array.from({ length: 21 }, () => md()));
  assert.equal(parsePageBlockInput(over), null);
  assert.match(pageBlockProblem(over), /blocks has more than 20 items/);
});

test('containers nest at most 2 levels', () => {
  assert.ok(parsePageBlockInput(toggle([toggle([md()])])));
  const deep = toggle([toggle([toggle([md()])])]);
  assert.equal(parsePageBlockInput(deep), null);
  assert.match(pageBlockProblem(deep), /blocks\[0\]\.blocks\[0\]\.blocks\[0\] is nested too deep; containers nest at most 2 levels/);
});

test('resource and conversation references stay at the top level', () => {
  for (const [type, example] of Object.entries(TOP_LEVEL_ONLY)) {
    assert.ok(parsePageBlockInput(example), `${type} is valid at the top level`);
    assert.equal(parsePageBlockInput(toggle([example])), null, `${type} is refused in a container`);
    assert.match(pageBlockProblem(toggle([example])), new RegExp(`blocks\\[0\\] is a ${type} block, which stays at the top level of the page`));
  }
});

test('columns, tabs and grid regions keep their counts', () => {
  const columns = (n: number) => ({ type: 'columns', columns: Array.from({ length: n }, () => [md()]) });
  const tabs = (n: number) => ({ type: 'tabs', tabs: Array.from({ length: n }, (_, i) => ({ label: `T${i}`, blocks: [md()] })) });
  const grid = (n: number, span = 1) => ({ type: 'grid', regions: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, span, blocks: [md()] })) });
  for (const [make, min, max] of [[columns, 2, 4], [tabs, 2, 6], [grid, 1, 12]] as const) {
    assert.ok(parsePageBlockInput(make(min)) && parsePageBlockInput(make(max)));
    assert.equal(parsePageBlockInput(make(min - 1)), null);
    assert.equal(parsePageBlockInput(make(max + 1)), null);
  }
  assert.ok(parsePageBlockInput(grid(1, 12)));
  assert.equal(parsePageBlockInput(grid(1, 13)), null);
});

test('the constants are the limits the parser and the block catalog state', () => {
  assert.deepEqual(Object.keys(TOP_LEVEL_ONLY).sort(), [...TOP_LEVEL_ONLY_BLOCK_TYPES].sort());
  assert.deepEqual(LIMITS, { depth: 2, slotBlocks: 20, columns: { min: 2, max: 4 }, tabs: { min: 2, max: 6 }, regions: { min: 1, max: 12 }, gridColumns: 12 });
  type S = { properties: Record<string, any> };
  const props = (type: 'toggle' | 'columns' | 'tabs' | 'grid') => (PAGE_BLOCK_CATALOG[type].schema as S).properties;
  assert.equal(props('toggle').blocks.maxItems, LIMITS.slotBlocks);
  const { columns } = props('columns');
  assert.deepEqual([columns.minItems, columns.maxItems, columns.items.maxItems], [LIMITS.columns.min, LIMITS.columns.max, LIMITS.slotBlocks]);
  const { tabs } = props('tabs');
  assert.deepEqual([tabs.minItems, tabs.maxItems, tabs.items.properties.blocks.maxItems], [LIMITS.tabs.min, LIMITS.tabs.max, LIMITS.slotBlocks]);
  const { regions } = props('grid');
  assert.deepEqual([regions.minItems, regions.maxItems, regions.items.properties.blocks.maxItems, regions.items.properties.span.maximum],
    [LIMITS.regions.min, LIMITS.regions.max, LIMITS.slotBlocks, LIMITS.gridColumns]);
});

test('every container kind lists and maps its children, and pageSegmentSources reads them', () => {
  const source = (nodeId: string) => ({ nodeId, turnId: 't', assistantId: 'a' });
  const cited = (nodeId: string) => ({ type: 'markdown' as const, text: 'x', segmentSources: [{ text: 'x', sources: [source(nodeId)] }] });
  const blocks: PageBlockInput[] = [
    { type: 'toggle', title: 'T', blocks: [cited('a')] },
    { type: 'columns', columns: [[cited('b')], [cited('c')]] },
    { type: 'tabs', tabs: [{ label: 'A', blocks: [cited('d')] }, { label: 'B', blocks: [] }] },
    { type: 'grid', regions: [{ id: 'r', span: 12, blocks: [cited('e')] }] },
  ];
  assert.deepEqual(blocks.map((block) => pageChildBlockLists(block).length), [1, 2, 2, 1]);
  assert.deepEqual(blocks.flatMap(pageSegmentSources).map((s) => s.nodeId), ['a', 'b', 'c', 'd', 'e']);
  const renamed = blocks.map((block) => mapPageChildBlocks(block, (child) => ({ ...child, text: 'y' }) as typeof child));
  assert.deepEqual(renamed.flatMap((block) => pageChildBlockLists(block).flat().map((child) => (child as { text: string }).text)), ['y', 'y', 'y', 'y', 'y']);
  assert.deepEqual(pageChildBlockLists(cited('z')), []);
  const leaf = cited('z');
  assert.equal(mapPageChildBlocks(leaf, (child) => child), leaf);
});
