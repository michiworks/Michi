import type { AgentCommand } from 'michi-shared';
import { configValues, type AcpSessionInfo, type KiroEngine } from './kiroProtocol';

export const V3_COMMAND_METHODS: Readonly<Record<string, string>> = {
    compact: '_kiro/session/compact', context: '_kiro/session/context',
    history: '_kiro/session/history', export: '_kiro/session/export',
    code: '_kiro/codeIntelligence', usage: '_kiro/account/getUsage',
};

/** CLI 2.28 serves these established methods but omits them from its V3
 * advertisement. Keep this compatibility exception explicit and narrow;
 * -32601 disables a method for the rest of this connection. No other missing
 * advertisement is treated as permission to call an extension. */
export const V3_COMPATIBILITY_METHODS: ReadonlySet<string> = new Set([
    '_session/steer', '_session/steer/clear', '_kiro/account/getUsage',
]);

export function v3CommandNames(info: AcpSessionInfo | undefined, supports: (method: string) => boolean): string[] {
    return ['clear', 'tools', 'mcp', ...(info?.configOptions?.some((c) => c.id === 'effortLevel') ? ['effort'] : []),
        ...Object.keys(V3_COMMAND_METHODS).filter((command) => supports(V3_COMMAND_METHODS[command]))];
}

export function effortSelection(info: AcpSessionInfo | undefined, value: unknown):
    { value: string } | { message: string } {
    const effort = info?.configOptions?.find((option) => option.id === 'effortLevel');
    if (!effort) return { message: 'This Kiro session does not expose configurable effort.' };
    const values = configValues(effort).map((option) => option.value);
    if (typeof value !== 'string' || !values.includes(value)) return {
        message: `Current effort: ${effort.currentValue ?? 'unknown'}. Available: ${values.join(', ') || 'none'}.`,
    };
    return { value };
}

const KIRO_COMMAND_INFO: Readonly<Record<string, Omit<AgentCommand, 'name' | 'kind'>>> = {
    clear: { description: 'Start Kiro on a fresh context; the messages stay in Michi' },
    tools: { description: 'Show the tools this chat has' },
    mcp: { description: 'Show the MCP servers and their status' },
    effort: { description: 'Show the reasoning effort, or set it', argumentHint: '[level]' },
    context: { description: 'Show what fills the context window' },
    history: { description: 'Show the history Kiro keeps for this chat' },
    export: { description: 'Export this chat from Kiro' },
    code: { description: 'Show the code intelligence status' },
    usage: { description: 'Show your Kiro usage' },
};

/** A command Michi's Kiro command interface runs (executeCommand), described. */
export function kiroCommand(name: string): AgentCommand {
    return { name, kind: 'command', ...KIRO_COMMAND_INFO[name] };
}

/**
 * The commands a Kiro chat runs before it has a session
 * (AgentRuntime.hostCommands). V2: its command RPC's. V3: every one Michi's
 * command interface runs, since a chat without live state (a new one, any
 * after a reload) would send the others to Kiro as a prompt. /effort needs
 * a session that exposes effortLevel and /context, /history, /export,
 * /code and /usage an extension the kiro-cli advertises: the session's
 * state (v3CommandNames) names the ones it runs, and running another
 * answers that this Kiro does not support it. `/compact` is the host's own.
 */
export function kiroHostCommands(engine: KiroEngine): AgentCommand[] {
    const names = engine === 'v3'
        ? ['clear', 'tools', 'mcp', 'effort', ...Object.keys(V3_COMMAND_METHODS).filter((name) => name !== 'compact')]
        : ['clear', 'tools', 'context', 'effort'];
    return names.map(kiroCommand);
}
