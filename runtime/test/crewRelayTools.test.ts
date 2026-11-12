import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrewMcpHandlers } from '../src/adapters/crew/crewMcpRelay';
import { CREW_KIRO_FLAVOR } from '../src/adapters/crew/crewFlavor';
import { CREW_RELAY_CALL_TOOL, CREW_RELAY_LIST_TOOL, crewRelayedHostTool } from '../src/adapters/crew/crewRelayTools';

// A Gateway approval as the Crew ACP adapter forwards it (acp/acpServer.ts
// requestPermission): the stable tool name in _meta, the Gateway's title, and
// its tool input as the raw input.
function request(toolName: unknown, title: unknown, rawInput: unknown = '') {
    return { toolCall: { toolCallId: 'tool-1', title, rawInput }, meta: { toolName } };
}
const CALL_TITLE = '@michi-crew-runtime:michi/michi_call_tool';
const call = (input: unknown, title = CALL_TITLE) => request(CREW_RELAY_CALL_TOOL, title, typeof input === 'string' ? input : JSON.stringify(input));
const named = ({ toolCall, meta }: ReturnType<typeof request>) => crewRelayedHostTool(toolCall, meta);

test('the relay serves the two tools Crew permission naming reads, and the Crew flavor names its requests by them', async () => {
    const { tools } = await createCrewMcpHandlers().listTools();
    assert.deepEqual(tools.map((tool) => tool.name), [CREW_RELAY_LIST_TOOL, CREW_RELAY_CALL_TOOL]);
    assert.equal(CREW_KIRO_FLAVOR.tools?.relayedHostTool, crewRelayedHostTool);
});

test('a relay call is named for the Michi tool its input names, a listing for the listing', () => {
    assert.equal(named(call({ tool: 'read_node', arguments: { nodeId: 'n-1' } })), '@michi/read_node');
    assert.equal(named(call({ tool: 'memory_save', arguments: { body: 'x' } })), '@michi/memory_save');
    assert.equal(named(call({ tool: 'edit_page', arguments: {} })), '@michi/edit_page', 'named, whatever the policy says');
    assert.equal(named(call({ tool: 'read_node', arguments: {}, sessionKey: 'other' })), '@michi/read_node', 'the relay reads only tool and arguments');
    assert.equal(crewRelayedHostTool({ title: CALL_TITLE, rawInput: { tool: 'list_threads', arguments: {} } }, { toolName: CREW_RELAY_CALL_TOOL }),
        '@michi/list_threads', 'an input object');
    assert.equal(named(request(CREW_RELAY_LIST_TOOL, '@michi-crew-runtime:michi/michi_list_tools')), '@michi/michi_list_tools');
    for (const title of ['@my-app:michi/michi_call_tool', '@michi/michi_call_tool', 'Calling @michi-crew-runtime:michi/michi_call_tool (read_node)']) {
        assert.equal(named(call({ tool: 'read_node', arguments: {} }, title)), '@michi/read_node', title);
    }
});

test('a request is a relay call only when the Gateway names the relay tool and its App\'s michi server', () => {
    const input = { tool: 'read_node', arguments: {} };
    const cases: Array<[string, ReturnType<typeof request>]> = [
        ['a Crew built-in', request('shell', 'shell', JSON.stringify(input))],
        ['no stable tool name', request(undefined, CALL_TITLE, JSON.stringify(input))],
        ['a qualified tool name', request(CALL_TITLE, CALL_TITLE, JSON.stringify(input))],
        ['another server\'s tool of the same name', call(input, '@my-app:github/michi_call_tool')],
        ['a title without the server', call(input, 'michi_call_tool')],
        ['a title naming the other relay tool', call(input, '@michi-crew-runtime:michi/michi_list_tools')],
        ['a longer tool name in the title', call(input, '@michi-crew-runtime:michi/michi_call_tools')],
        ['an App name the Gateway refuses', call(input, '@My App:michi/michi_call_tool')],
        ['no title', request(CREW_RELAY_CALL_TOOL, undefined, JSON.stringify(input))],
    ];
    for (const [label, req] of cases) assert.equal(named(req), undefined, label);
    assert.equal(crewRelayedHostTool(undefined, undefined), undefined);
});

test('a relay call whose input the relay would refuse names no Michi tool', () => {
    const inputs: Array<[string, unknown]> = [
        ['empty', ''],
        ['not JSON', 'tool=read_node'],
        ['cut off', '{"tool":"read_node","arguments":{"nodeId":"n'],
        ['no arguments', { tool: 'read_node' }],
        ['arguments not an object', { tool: 'read_node', arguments: [] }],
        ['prose for a tool', { tool: 'read node', arguments: {} }],
        ['no tool', { arguments: { tool: 'read_node' } }],
        ['a tool that is not a string', { tool: 7, arguments: {} }],
        ['a list', [{ tool: 'read_node', arguments: {} }]],
    ];
    for (const [label, input] of inputs) assert.equal(named(call(input)), undefined, label);
    // The tool is the one the relay runs: a nested or earlier "tool" cannot stand in for it.
    assert.equal(named(call({ arguments: { tool: 'read_node' }, tool: 'edit_page' })), '@michi/edit_page');
    assert.equal(named(call('{"tool":"read_node","arguments":{},"tool":"edit_page"}')), '@michi/edit_page');
});
