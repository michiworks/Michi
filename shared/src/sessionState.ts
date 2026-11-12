import type { RuntimeReasoning } from './agentRuns';
import { isReasoningLevel, sanitizeReasoningLevels, type ModelReasoningCapabilities } from './reasoning';

export interface AgentCommand {
  name: string;
  description?: string;
  /** Present when the command takes text after its name (ACP: `unstructured`, with an optional hint). */
  input?: { type?: string; hint?: string };
  /** What the runtime says it is. Absent means a command. */
  kind?: 'command' | 'skill' | 'prompt';
  /** Shown after the name in the / menu, e.g. "<file> [focus]". */
  argumentHint?: string;
  /** Other names the runtime also runs it by. */
  aliases?: string[];
}

const AGENT_COMMAND_KINDS = new Set(['command', 'skill', 'prompt']);

function parseAgentCommand(command: unknown): AgentCommand[] {
  if (!command || typeof command !== 'object') return [];
  const raw = command as Record<string, unknown>;
  if (typeof raw.name !== 'string' || !raw.name) return [];
  const input = raw.input && typeof raw.input === 'object' ? raw.input as Record<string, unknown> : undefined;
  const inputType = typeof input?.type === 'string' ? input.type : undefined;
  const inputHint = typeof input?.hint === 'string' ? input.hint : undefined;
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((alias): alias is string => typeof alias === 'string' && alias.length > 0) : [];
  return [{
    name: raw.name,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(inputType !== undefined || inputHint !== undefined
      ? { input: { ...(inputType !== undefined ? { type: inputType } : {}), ...(inputHint !== undefined ? { hint: inputHint } : {}) } }
      : {}),
    ...(typeof raw.kind === 'string' && AGENT_COMMAND_KINDS.has(raw.kind) ? { kind: raw.kind as AgentCommand['kind'] } : {}),
    ...(typeof raw.argumentHint === 'string' && raw.argumentHint ? { argumentHint: raw.argumentHint } : {}),
    ...(aliases.length ? { aliases } : {}),
  }];
}

/** Commands from an untrusted payload, keeping only well-formed fields. */
export function parseAgentCommands(value: unknown): AgentCommand[] {
  return Array.isArray(value) ? value.flatMap(parseAgentCommand) : [];
}

/** Replaceable session state, independent of transcript/turn sequence numbers. */
export interface AgentSessionState {
  runtimeId: string;
  nativeEngine?: string;
  version?: number;
  currentModeId?: string | null;
  modelId?: string | null;
  reasoning?: RuntimeReasoning | null;
  availableModes?: Array<{ id: string; name: string; description?: string }>;
  availableModels?: Array<ModelReasoningCapabilities & { id: string; label?: string; description?: string }>;
  commands?: AgentCommand[];
  mcpErrors?: Array<{ serverName: string; error: string }>;
  /** A chat session that can run Ultracode (AgentCapabilities.ultracode); absent otherwise. */
  ultracode?: SessionUltracodeState;
}

/**
 * The chat's Ultracode choice and what the agent reports of it. `active` and
 * `available` are absent until the agent has reported them.
 */
export interface SessionUltracodeState {
  /** The chat asks for Ultracode. */
  requested: boolean;
  /** It is in effect: requested, and available. */
  active?: boolean;
  /** This session could run it (its model and setup support it). */
  available?: boolean;
}

function parseUltracodeState(value: unknown): SessionUltracodeState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.requested !== 'boolean') return undefined;
  return {
    requested: raw.requested,
    ...(typeof raw.active === 'boolean' ? { active: raw.active } : {}),
    ...(typeof raw.available === 'boolean' ? { available: raw.available } : {}),
  };
}

export function parseSessionState(data: Record<string, unknown>): AgentSessionState {
  const state: AgentSessionState = { runtimeId: typeof data.runtimeId === 'string' ? data.runtimeId : '' };
  if (typeof data.version === 'number' && Number.isFinite(data.version)) state.version = data.version;
  if (typeof data.nativeEngine === 'string') state.nativeEngine = data.nativeEngine;
  const ultracode = parseUltracodeState(data.ultracode);
  if (ultracode) state.ultracode = ultracode;
  for (const key of ['currentModeId', 'modelId'] as const) {
    if (typeof data[key] === 'string' || data[key] === null) state[key] = data[key];
  }
  if (data.reasoning === null || isReasoningLevel(data.reasoning)) state.reasoning = data.reasoning;
  if (Array.isArray(data.availableModes)) state.availableModes = data.availableModes.flatMap((mode) =>
    mode && typeof mode.id === 'string' ? [{ id: mode.id, name: typeof mode.name === 'string' ? mode.name : mode.id,
      ...(typeof mode.description === 'string' ? { description: mode.description } : {}),
    }] : []);
  if (Array.isArray(data.availableModels)) state.availableModels = data.availableModels.flatMap((model) =>
    model && typeof model.id === 'string' ? [{ id: model.id,
      ...(typeof model.label === 'string' ? { label: model.label } : {}),
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      ...(typeof model.supportsReasoning === 'boolean' ? { supportsReasoning: model.supportsReasoning } : {}),
      ...(Array.isArray(model.supportedReasoningLevels) ? { supportedReasoningLevels: sanitizeReasoningLevels(model.supportedReasoningLevels) } : {}),
      ...(isReasoningLevel(model.defaultReasoning) ? { defaultReasoning: model.defaultReasoning } : {}),
    }] : []);
  if (Array.isArray(data.commands)) state.commands = parseAgentCommands(data.commands);
  if (Array.isArray(data.mcpErrors)) state.mcpErrors = data.mcpErrors.flatMap((error) =>
    error && typeof error.serverName === 'string' && typeof error.error === 'string'
      ? [{ serverName: error.serverName, error: error.error }] : []);
  return state;
}
