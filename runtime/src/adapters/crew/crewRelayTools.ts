// The tools Michi's relay (crewMcpRelay) gives a Crew agent for Michi's own
// MCP tools, and the Michi tool a permission request for one of them runs.

/** Lists the Michi tools of the agent's conversation with their input schemas. */
export const CREW_RELAY_LIST_TOOL = 'michi_list_tools';
/** Calls one of those tools: `{ tool, arguments }`. */
export const CREW_RELAY_CALL_TOOL = 'michi_call_tool';

/**
 * A Gateway title naming a relay tool of a Crew App's `michi` server
 * (crew-app/app.json): `@<app>:michi/<tool>`, App names as the Gateway
 * accepts them.
 */
const RELAY_TITLE = /(?:^|\s)@(?:[a-z0-9][a-z0-9-]{0,63}:)?michi\/(michi_list_tools|michi_call_tool)(?![\w-])/;

/** An MCP tool name, not prose. */
const TOOL_NAME = /^[A-Za-z_][\w-]*$/;

/** The tool a relay call's input names, when the relay would run it: `{"tool": <name>, "arguments": {...}}`. */
function calledTool(input: unknown): string | undefined {
    let call = input;
    if (typeof call === 'string') {
        try { call = JSON.parse(call); } catch { return undefined; }
    }
    if (!call || typeof call !== 'object' || Array.isArray(call)) return undefined;
    const { tool, arguments: args } = call as { tool?: unknown; arguments?: unknown };
    return typeof tool === 'string' && TOOL_NAME.test(tool) && !!args && typeof args === 'object' && !Array.isArray(args)
        ? tool : undefined;
}

/**
 * The Michi tool a Crew permission request runs through the relay, by Kiro's
 * name for a Michi tool (`@michi/<tool>`), for Michi's chat policy and
 * grants (AcpAgentFlavor.tools.relayedHostTool). The Gateway names the relay
 * tool itself in `_meta.toolName`, bare, and titles the request with its App's
 * server, which tells it from another server's tool of the same name. A call
 * runs the tool its input names; a listing runs none and is named
 * `@michi/michi_list_tools`. Undefined for any other request and for a call
 * whose input the relay would refuse.
 */
export function crewRelayedHostTool(toolCall: Record<string, any> | undefined, meta: Record<string, any> | undefined): string | undefined {
    const relay = meta?.toolName;
    if (relay !== CREW_RELAY_LIST_TOOL && relay !== CREW_RELAY_CALL_TOOL) return undefined;
    const title = typeof toolCall?.title === 'string' ? RELAY_TITLE.exec(toolCall.title) : null;
    if (title?.[1] !== relay) return undefined;
    const tool = relay === CREW_RELAY_LIST_TOOL ? relay : calledTool(toolCall?.rawInput);
    return tool && `@michi/${tool}`;
}
