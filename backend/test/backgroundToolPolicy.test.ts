import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canUseExternalTool, readBackgroundToolOverrides, readOnlyOverrideTools } from '../src/services/metaAgent/backgroundToolPolicy';

function configFile(t: { after(fn: () => void): void }, text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'michi-tool-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, text);
  return file;
}

test('overrides are server/tool with a known rule, the server matched with or without -mcp; anything else grants nothing', (t) => {
  const overrides = readBackgroundToolOverrides(configFile(t, JSON.stringify({ backgroundToolOverrides: {
    'example-search-mcp/search_documents': 'read-only', 'builder/run': 'deny', 'search': 'read-only', 'a/b/c': 'read-only', 'x/y': 'allow',
  } })));
  assert.deepEqual([...overrides], [['example-search/search_documents', 'read-only'], ['builder/run', 'deny']]);
  assert.equal(canUseExternalTool('maintenance', { server: 'example-search', tool: 'search_documents' }, overrides), true, 'Michi\'s name for the server');
  assert.equal(canUseExternalTool('maintenance', { server: 'example-search-mcp', tool: 'search_documents' }, overrides), true, 'Kiro\'s');
  for (const text of ['{', '[]', JSON.stringify({ backgroundToolOverrides: ['example-search/search_documents'] })]) {
    assert.equal(readBackgroundToolOverrides(configFile(t, text)).size, 0, text);
  }
  assert.equal(readBackgroundToolOverrides(path.join(os.tmpdir(), 'michi-no-such-dir', 'config.json')).size, 0);
});

test('only Pages upkeep reads outside Michi; an override never beats a declared write', () => {
  const overrides = new Map([['example-search/search_documents', 'read-only'], ['docs/get', 'deny']] as const);
  const declared = { annotations: { readOnlyHint: true } };
  for (const toolset of ['chat', 'memory'] as const) {
    assert.equal(canUseExternalTool(toolset, { server: 'docs', tool: 'find', ...declared }, overrides), false, toolset);
    assert.deepEqual(readOnlyOverrideTools(toolset, overrides), [], toolset);
  }
  assert.equal(canUseExternalTool('maintenance', { server: 'docs', tool: 'find', ...declared }, overrides), true);
  assert.equal(canUseExternalTool('maintenance', { server: 'docs', tool: 'get', ...declared }, overrides), false, 'deny wins');
  assert.equal(canUseExternalTool('maintenance', { server: 'docs', tool: 'find' }, overrides), false, 'no declaration, no override');
  for (const facts of [{ annotations: { readOnlyHint: false } }, { annotations: { destructiveHint: true } }, { taskSupport: 'required' }]) {
    assert.equal(canUseExternalTool('maintenance', { server: 'example-search', tool: 'search_documents', ...facts }, overrides), false, JSON.stringify(facts));
  }
  assert.deepEqual(readOnlyOverrideTools('maintenance', overrides), ['example-search/search_documents']);
});
