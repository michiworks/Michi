import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isAssistantWorkspaceSettings, isSystemWorkspaceSettings, parseWorkspaceSettings, workspaceSystemOf } from '../src/index';

describe('workspace settings JSON', () => {
  // raw → [parsed, system flag]; any non-null `system` marks a system workspace, as the SQL predicates read it.
  const table: Array<[string | null, Record<string, unknown> | null, string | undefined]> = [
    [null, null, undefined],
    ['', null, undefined],
    ['null', null, undefined],
    ['[]', null, undefined],
    ['"x"', null, undefined],
    ['{bad', null, undefined],
    ['{"system":"assistant"}', { system: 'assistant' }, 'assistant'],
    ['{"system":""}', { system: '' }, '""'],
    ['{"system":true}', { system: true }, 'true'],
    ['{"system":null}', { system: null }, undefined],
    ['{"aiGlobalContext":false}', { aiGlobalContext: false }, undefined],
  ];

  for (const [raw, parsed, system] of table) {
    test(`reads ${raw}`, () => {
      assert.deepEqual(parseWorkspaceSettings(raw), parsed);
      assert.equal(workspaceSystemOf(parseWorkspaceSettings(raw)), system);
      assert.equal(isSystemWorkspaceSettings(raw), system !== undefined);
      assert.equal(isAssistantWorkspaceSettings(raw), system === 'assistant');
    });
  }
});
