import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isTurnMetadataToolTitle, LEGACY_METADATA_TOOL_NAMES, MICHI_MCP_SERVER, MICHI_MCP_SERVER_NAMES, michiBareToolName, parseToolTitle,
  TURN_METADATA_TOOL_NAMES,
} from '../src/index';

test("a title's server and tool, in every runtime's spelling", () => {
  for (const [title, parsed] of [
    ['read_node', { name: 'read_node' }],
    ['mcp____michi_internal____read_node', { server: '__michi_internal__', name: 'read_node' }],
    ['mcp__michi-tools__read_node', { server: 'michi-tools', name: 'read_node' }],
    ['mcp__notion__set_title', { server: 'notion', name: 'set_title' }],
    ['@michi/read_node', { server: 'michi', name: 'read_node' }],
    ['Running: @michi/read_node', { server: 'michi', name: 'read_node' }],
    ['michi_internal____read_node', { server: 'michi_internal', name: 'read_node' }],
    ['notion____set_title', { server: 'notion', name: 'set_title' }],
    ['github::get_issue', { server: 'github', name: 'get_issue' }],
    ['shots.capture', { server: 'shots', name: 'capture' }],
    ['Edit /tmp/a.ts', { name: 'Edit /tmp/a.ts' }],
  ] as const) assert.deepEqual(parseToolTitle(title), parsed, title);
});

test("only Michi's servers, exactly, or no server name a Michi tool", () => {
  for (const title of ['read_node', 'mcp____michi_internal____read_node', '@michi/read_node', 'michi_internal____read_node', 'mcp__michi_internal__read_node']) {
    assert.equal(michiBareToolName(title), 'read_node', title);
  }
  for (const title of ['mcp__michigan__read_node', '@michigan/read_node', 'mcp__notion__read_node', 'michi-x____read_node']) {
    assert.equal(michiBareToolName(title), undefined, title);
  }
});

test('turn metadata is Michi\'s alone, and old history\'s set_title still counts', () => {
  assert.equal(isTurnMetadataToolTitle('mcp____michi_internal____set_follow_ups'), true);
  assert.equal(isTurnMetadataToolTitle('set_title'), true);
  assert.equal(isTurnMetadataToolTitle('mcp__notion__set_title'), false);
  assert.equal(isTurnMetadataToolTitle('read_node'), false);
});

test("every runtime's spelling of a Michi tool names it", () => {
  assert.ok(MICHI_MCP_SERVER_NAMES.has(MICHI_MCP_SERVER), 'the server Claude and Codex register is one of Michi\'s');
  for (const title of [
    `mcp__${MICHI_MCP_SERVER}__read_node`, 'mcp__michi__read_node', 'mcp__michi-tools__read_node', 'mcp__Michi__read_node',
    '@michi/read_node', '@Michi/read_node', 'Completed: @michi/read_node', 'Failed: @michi/read_node',
    'Interrupted: @michi/read_node', 'running: @michi/read_node',
    'michi::read_node', 'michi.read_node', 'michi:read_node', 'michi/read_node', 'michi__read_node', '  read_node  ',
  ]) assert.equal(michiBareToolName(title), 'read_node', title);
});

test('each turn-metadata name, current or legacy, is hidden under Michi\'s spellings only', () => {
  for (const name of [...TURN_METADATA_TOOL_NAMES, ...LEGACY_METADATA_TOOL_NAMES]) {
    for (const title of [name, name.toUpperCase(), `mcp__${MICHI_MCP_SERVER}__${name}`, `mcp__michi-tools__${name}`,
      `Completed: @michi/${name}`, `michi_internal____${name}`, `michi.${name}`]) {
      assert.equal(isTurnMetadataToolTitle(title), true, title);
    }
    for (const title of [`@notion/${name}`, `Running: @notion/${name}`, `notion____${name}`, `notion::${name}`, `${name}_v2`]) {
      assert.equal(isTurnMetadataToolTitle(title), false, title);
    }
  }
});
