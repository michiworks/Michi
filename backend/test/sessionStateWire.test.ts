import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseChatStreamEvent, type AgentCommand, type AgentSessionState } from 'michi-shared';
import { sessionStateForFeed } from '../src/routes/sessionStateWire';

const description = 'Use when the user asks to review a change. '.repeat(10);

const hostCommands: AgentCommand[] = [
  { name: 'status', description: 'Show the session, its model, permission mode and MCP servers', kind: 'command' },
  { name: 'model', description: 'Show the models, or switch to one', kind: 'command', argumentHint: '[model]' },
  { name: 'compact', description: 'Summarize the conversation', input: { type: 'unstructured', hint: '[instructions]' } },
];

/** A Claude session as the audit measured it: about 110 skill rows, each with a long description. */
function claudeState(): AgentSessionState {
  return {
    runtimeId: 'claude', nativeEngine: 'agent-sdk', version: 7, modelId: 'opus', currentModeId: 'default',
    availableModes: [{ id: 'default', name: 'Default', description: 'Ask before edits' }],
    availableModels: [{ id: 'opus', label: 'Opus', description: 'Most capable' }],
    mcpErrors: [{ serverName: 'builder', error: 'timed out' }],
    ultracode: { requested: true, active: false },
    commands: [
      ...hostCommands,
      ...Array.from({ length: 110 }, (_, index): AgentCommand => ({
        name: `plugin-${index % 7}:skill-${index}`, description, kind: 'skill',
        ...(index % 3 === 0 ? { argumentHint: '<file>' } : {}),
        ...(index % 5 === 0 ? { aliases: [`skill-${index}`] } : {}),
      })),
      { name: 'release-notes', description: 'A saved prompt', kind: 'prompt' },
    ],
  };
}

test('the feed copy of a Claude session drops prompts and skill descriptions and keeps the rest', () => {
  const state = claudeState();
  const before = JSON.stringify(state);
  const projected = sessionStateForFeed(state);

  assert.equal(JSON.stringify(state), before, 'the session\'s own state is not changed');
  assert.ok(before.length > 45_000, `the fixture is a full skill table (${before.length} B)`);
  assert.ok(JSON.stringify(projected).length <= 12 * 1024, `projected to ${JSON.stringify(projected).length} B`);

  const { commands, ...rest } = projected;
  const { commands: original, ...originalRest } = state;
  assert.deepEqual(rest, originalRest, 'modes, models, ultracode and errors go as they are');
  assert.deepEqual(commands!.filter((command) => command.kind !== 'skill'), hostCommands, 'commands keep every field');
  assert.equal(commands!.some((command) => command.kind === 'prompt'), false);
  const skills = commands!.filter((command) => command.kind === 'skill');
  assert.equal(skills.length, 110);
  assert.deepEqual(skills, original!.filter((command) => command.kind === 'skill').map(({ description: _, ...skill }) => skill),
    'a skill keeps its name, hint and aliases');
});

test('commands stay in the frame whenever the session reports them, and only then', () => {
  const restricted: AgentSessionState = { runtimeId: 'claude', commands: [] };
  assert.deepEqual(sessionStateForFeed(restricted), { runtimeId: 'claude', commands: [] });
  const onlyPrompts: AgentSessionState = { runtimeId: 'kiro', commands: [{ name: 'p', kind: 'prompt' }] };
  assert.deepEqual(sessionStateForFeed(onlyPrompts).commands, [], 'an empty list still clears a window\'s menu');
  const none: AgentSessionState = { runtimeId: 'kiro', currentModeId: 'agent' };
  assert.equal('commands' in sessionStateForFeed(none), false, 'a state without commands leaves a window\'s menu alone');
});

test('a window parses the feed copy into the same menu rows', () => {
  const projected = sessionStateForFeed(claudeState());
  const parsed = parseChatStreamEvent('session_state', JSON.stringify({ ...projected, nodeId: 'n-1', chatId: 'n-1' }));
  assert.equal(parsed?.event, 'session_state');
  assert.deepEqual(parsed?.event === 'session_state' ? parsed.data.commands : undefined, projected.commands);
});
