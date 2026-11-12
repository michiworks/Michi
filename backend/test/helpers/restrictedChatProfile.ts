import { META_AGENT_CHAT_TOOL_NAMES } from '../../src/assistant/policy';
import type { RuntimeToolProfile } from '../../src/agents/types';

/** Explicit closed chat profile for the adapters' restriction contract tests. */
export function restrictedChatProfile(): RuntimeToolProfile {
  return { allowedToolNames: META_AGENT_CHAT_TOOL_NAMES, assistant: true, restricted: true, metaAgentToolset: 'chat' };
}
