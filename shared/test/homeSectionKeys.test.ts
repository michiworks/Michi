import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOME_SECTION_KEYS, HOME_SECTION_TITLES, PAGE_BLOCK_CATALOG, parsePageBlockInput } from '../src/pages';

test('a home-section block accepts every Home section key and nothing else', () => {
  for (const section of HOME_SECTION_KEYS) assert.deepEqual(parsePageBlockInput({ type: 'home-section', section }), { type: 'home-section', section });
  assert.equal(parsePageBlockInput({ type: 'home-section', section: 'doing' }), null);
});

test('the block catalog offers the Home sections with their headings', () => {
  const entry = PAGE_BLOCK_CATALOG['home-section'];
  assert.deepEqual((entry.schema as { properties: { section: { enum: unknown } } }).properties.section.enum, [...HOME_SECTION_KEYS]);
  for (const section of HOME_SECTION_KEYS) assert.equal(entry.title({ type: 'home-section', section }), HOME_SECTION_TITLES[section]);
});
