/**
 * Unit tests for claudeMcpConfig.ts
 *
 * Uses node:test (Node 22+) + ts-node.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeMcpConfig, CLAUDE_UP_FRONT_TOOL_META, MICHI_INTERNAL_MCP_NAME } from '../src/adapters/claude/claudeMcpConfig';

describe('claudeMcpConfig', () => {

  // Case 5: type is 'http'
  test('buildClaudeMcpConfig sets type to http', () => {
    const json = buildClaudeMcpConfig({ url: 'http://127.0.0.1:9000/api/mcp/slot-type' });
    const parsed = JSON.parse(json);
    assert.equal(parsed.mcpServers[MICHI_INTERNAL_MCP_NAME].type, 'http');
  });

  test("buildClaudeMcpConfig takes the slot endpoint's URL and no headers", () => {
    const endpoint = { type: 'http' as const, url: 'http://127.0.0.1:9000/api/mcp/slot-a', headers: [] };
    assert.deepEqual(JSON.parse(buildClaudeMcpConfig(endpoint)), {
      mcpServers: { [MICHI_INTERNAL_MCP_NAME]: { type: 'http', url: endpoint.url } },
    });
    assert.deepEqual(JSON.parse(buildClaudeMcpConfig(endpoint, { alwaysLoad: true })).mcpServers[MICHI_INTERNAL_MCP_NAME],
      { type: 'http', url: endpoint.url, alwaysLoad: true });
  });

  test('a tool the host marks loadUpFront carries the tool _meta Claude Code reads to load it without a tool search', () => {
    assert.deepEqual({ ...CLAUDE_UP_FRONT_TOOL_META }, { 'anthropic/alwaysLoad': true });
    assert.equal(Object.isFrozen(CLAUDE_UP_FRONT_TOOL_META), true);
  });
});
