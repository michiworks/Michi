/**
 * Tests for Step 3 of Claude Code Runtime:
 *   - McpSlotRegistry (extended with transport ownership)
 *   - the follow-up tool; the removed approve tool stays gone
 *
 * Uses node:test (Node 22+) + ts-node.
 * Run: cd backend && npm test -- --test-name-pattern mcpServerStep3
 *
 * Strategy: direct handler invocation via McpServer._registeredTools[name].handler
 * to avoid spinning up a real HTTP server for unit-level tool tests.
 * McpSlotRegistry is tested by exercising its public API directly.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    McpSlotRegistry,
    buildMcpServerForSlot,
} from '../src/services/mcpServer';
import { runOwner } from './helpers/owners';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal no-op callbacks that satisfy McpSlotCallbacks. */
function makeCallbacks() {
    return {
        onSpawnBranches: async () => [],
        onSaveArtifact: () => null,
        onUpdateArtifact: () => null,
        onShowImage: () => ({ error: 'unsupported in test' }),
    };
}

function getToolHandler(
    registry: McpSlotRegistry,
    slotId: string,
    toolName: string,
): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }> {
    const slot = registry.get(slotId)!;
    const server = buildMcpServerForSlot(slot);
    const registeredTools = (server as unknown as {
        _registeredTools: Record<string, { handler: (a: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools;
    const toolEntry = registeredTools[toolName];
    assert.ok(toolEntry, `${toolName} tool must be registered on the McpServer`);
    return toolEntry.handler as (args: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
    }>;
}

// ---------------------------------------------------------------------------
// Suite: McpSlotRegistry
// ---------------------------------------------------------------------------

describe('McpSlotRegistry', () => {
    let registry: McpSlotRegistry;

    beforeEach(() => {
        registry = new McpSlotRegistry();
    });

    test('generic Agent tools honor the session capability allow-list', () => {
        const slot = registry.create('attempt-tools', '/tmp', 'owner-a', {
            ...makeCallbacks(),
            agentRuns: { invoke: async () => ({ ok: true }) },
            agentRunToolNames: ['spawn_agent'],
        } as never);
        const tools = (buildMcpServerForSlot(slot) as any)._registeredTools;
        assert.ok(tools['spawn_agent']);
        assert.equal(tools['list_agents'], undefined);
        assert.equal(tools['wait_agent'], undefined);
    });

    test('run-owned slots do not register any tool outside exposedToolNames', () => {
        const slot = registry.create('attempt-strict-tools', '/tmp', 'owner-a', {
            ...makeCallbacks(),
            owner: runOwner('run-a', 'attempt-strict-tools'),
            exposedToolNames: new Set(['submit_agent_result']),
            onSubmitAgentResult: () => ({ version: 1, status: 'completed' }),
            onSetFollowUps: () => {},
            onSetBranchOverview: () => {},
            onAskUser: async () => ({}),
        } as never);
        const tools = (buildMcpServerForSlot(slot) as any)._registeredTools;

        assert.ok(tools['submit_agent_result']);
        for (const denied of [
            'spawn_branches', 'save_artifact', 'update_artifact', 'show_image',
            'set_follow_ups', 'set_branch_overview',
            'list_threads', 'search_messages', 'read_node', 'read_node_overview',
            'inspect_pane', 'read_pane_output', 'list_panes', 'wait_pane', 'send_to_thread', 'ask_user',
        ]) {
            assert.equal(tools[denied], undefined, `${denied} must not be registered`);
        }
    });

    test('a chat slot offers spawn_branches, save_artifact and update_artifact only with their callbacks', () => {
        const PRODUCT_TOOLS = { spawn_branches: 'onSpawnBranches', save_artifact: 'onSaveArtifact', update_artifact: 'onUpdateArtifact' } as const;
        const all = (buildMcpServerForSlot(registry.create('chat-all', '/tmp', null, makeCallbacks())) as any)._registeredTools;
        for (const name of Object.keys(PRODUCT_TOOLS)) assert.ok(all[name], `${name} is registered with its callback`);
        for (const [name, callback] of Object.entries(PRODUCT_TOOLS)) {
            const { [callback]: _left, ...rest } = makeCallbacks();
            const tools = (buildMcpServerForSlot(registry.create(`chat-without-${name}`, '/tmp', null, rest)) as any)._registeredTools;
            assert.equal(tools[name], undefined, `${name} is not registered without ${callback}`);
            for (const other of Object.keys(PRODUCT_TOOLS).filter((tool) => tool !== name)) assert.ok(tools[other], `${other} stays`);
        }
        const none = (buildMcpServerForSlot(registry.create('chat-none', '/tmp', null, { onShowImage: makeCallbacks().onShowImage })) as any)._registeredTools;
        for (const name of Object.keys(PRODUCT_TOOLS)) assert.equal(none[name], undefined);
        assert.ok(none['show_image'], 'the other side-effect tools are unaffected');
    });
});

describe('set_follow_ups MCP tool', () => {
    let registry: McpSlotRegistry;

    beforeEach(() => {
        registry = new McpSlotRegistry();
    });

    test('set_follow_ups trims values and forwards at most three questions', async () => {
        let captured: string[] = [];
        const slot = registry.create('chat-follow-ups-set', '/tmp', null, {
            ...makeCallbacks(),
            onSetFollowUps: (followUps: string[]) => { captured = followUps; },
        } as never);
        const handler = getToolHandler(registry, slot.slotId, 'set_follow_ups');

        const result = await handler({
            follow_ups: [' first? ', '', 'second?', ' third? ', 'fourth?'],
        });

        assert.deepEqual(captured, ['first?', 'second?', 'third?']);
        assert.equal(result.content[0].text, 'Follow-ups set: 3');
    });
});

// ---------------------------------------------------------------------------
// Suite: removed approve MCP tool
// ---------------------------------------------------------------------------

describe('approve MCP tool', () => {
    test('no slot offers it: Claude gates tools through the Agent SDK canUseTool', () => {
        const registry = new McpSlotRegistry();
        const slot = registry.create('chat-no-approve', '/tmp', null, {
            ...makeCallbacks(),
            onAskUser: async () => ({}),
            onApprove: async () => ({ behavior: 'allow' }),
        } as never);
        const tools = (buildMcpServerForSlot(slot) as any)._registeredTools;
        assert.ok(tools.ask_user);
        assert.equal(tools.approve, undefined);
    });
});

test('save_artifact forwards a file path without requiring a Markdown body', async () => {
    const registry = new McpSlotRegistry();
    let received: unknown[] = [];
    const slot = registry.create('file-chat', '/tmp', null, {
        ...makeCallbacks(),
        onSaveArtifact: (name, body, path) => {
            received = [name, body, path];
            return { name, filePath: path!, size: 5 };
        },
    });
    const handler = getToolHandler(registry, slot.slotId, 'save_artifact');
    await handler({ name: 'shot', path: '.attachments/shot.png' });
    assert.deepEqual(received, ['shot', undefined, '.attachments/shot.png']);
    await assert.rejects(() => handler({ name: 'shot', path: 'shot.png', body: 'text' }), /exactly one/);
});

test('ask_user rejects blank questions and options as a tool error without asking, as Pi and the runtime builtin do', async () => {
    const registry = new McpSlotRegistry();
    let asked = 0;
    const slot = registry.create('ask-chat', '/tmp', null, {
        ...makeCallbacks(),
        onAskUser: async () => { asked++; return {}; },
    } as never);
    const handler = getToolHandler(registry, slot.slotId, 'ask_user') as (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    for (const [questions, error] of [
        [[], 'questions must be an array of 1-4 questions.'],
        [[{ question: ' ', options: [{ label: 'A' }, { label: 'B' }] }], 'questions[0].question must be a non-empty string.'],
        [[{ question: 'Q?', options: [{ label: 'Only' }] }], 'questions[0].options must list 2-4 options.'],
        [[{ question: 'Q?', options: [{ label: 'A' }, { label: '' }] }], 'questions[0].options[1].label must be a non-empty string.'],
    ] as const) {
        const result = await handler({ questions });
        assert.equal(result.isError, true);
        assert.equal(result.content[0].text, error);
    }
    assert.equal(asked, 0);
});
