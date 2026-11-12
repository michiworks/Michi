import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { permissionDetail } from '../src/core/permissionPrompt';
import { codexPermissionRequest } from '../src/adapters/codex/codexApprovalMapping';

describe('permissionDetail', () => {
  it('shows what a request would do, the same for every runtime, with a visible cut on long values', () => {
    const command = `npm test -- ${'x'.repeat(288)}`;
    const long = 'y'.repeat(700);
    const cases: Array<[string, string, unknown, string | undefined]> = [
      ['a 300-character command, whole', 'bash', { command }, `Command: ${command}`],
      ['a longer command, cut', 'bash', { command: long }, `Command: ${'y'.repeat(597)}...`],
      ['a described command', 'bash', { description: 'Run the tests', command: 'npm test' }, 'Description: Run the tests\nCommand: npm test'],
      ["Codex's command", 'bash', { command: 'npm test', cwd: '/w' }, 'Command: npm test'],
      ["Pi's write", 'write', { path: '/w/notes.md', content: 'hello' }, 'File: /w/notes.md\nContent: 5 chars'],
      ["Claude's MultiEdit", 'edit', { file_path: '/w/a.ts', edits: [{}, {}] }, 'File: /w/a.ts\nEdits: 2'],
      ['an MCP tool, as compact JSON', 'search_messages', { query: 'deploy', limit: 5 }, '{"query":"deploy","limit":5}'],
      ['a long MCP input, cut', 'save_artifact', { body: long }, `${`{"body":"${long}"}`.slice(0, 597)}...`],
      ['an MCP tool without arguments', 'list_pages', {}, undefined],
      ['no input', 'bash', undefined, undefined],
    ];
    for (const [label, tool, input, expected] of cases) assert.equal(permissionDetail(tool, input), expected, label);
  });

  it("is what a Codex command approval shows, cut with the same mark", () => {
    const event = codexPermissionRequest(1, 'item/commandExecution/requestApproval', { command: 'z'.repeat(601) }, 'bash', []);
    assert.equal((event as { detail?: string }).detail, `Command: ${'z'.repeat(597)}...`);
  });
});
