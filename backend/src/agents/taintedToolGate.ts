/**
 * Michi's own tools hold the taint rule themselves (w3-fix D23, DESIGN-v2
 * §2.8 T5): a call of a Michi tool that makes other work run (`indirect`)
 * or acts outside Michi (`outside_write`, assistant/toolEffects.ts), from a
 * turn that holds check-in or collector material (turnTrust.ts
 * activeCompanionTaint: its own reads, or what its live session took in on
 * an earlier turn, D1 / D17), runs only with the user's approval for that
 * call, whatever runtime brought it.
 *
 * The runtime gate asks for such a call on Pi (in process: every call goes
 * through resolveChatPolicy) and on Claude (Michi's PreToolUse hook, D4), and
 * on Kiro when kiro-cli sends session/request_permission. It does not on
 * Codex (MCP calls never reach Michi's approval) or on Kiro when the user's
 * agent pre-allows `@michi` tools. So the MCP dispatch (services/mcpServer.ts
 * michiToolCatalog) checks every call: one Michi's runtime gate approved
 * (the permission port's `approved` note, recorded here per chat and running
 * turn) runs; any other asks through the slot's ask_user channel, or is
 * refused when there is none. Tools that ask the user for every effect
 * themselves (SELF_ASKING) are left to their own question.
 */

import { activeCompanionTaint, activeTurnTrust } from '../services/turnTrust';
import { michiBareToolName, michiToolEffect } from '../assistant/toolEffects';
import { log } from '../services/logger';

/**
 * Michi tools that ask the user for every effect themselves: a start, every
 * scheduled-job change but a pause (a create in such a turn too, whatever the
 * user's setting: agents/scheduledJobTools.ts), and a follow-up from a
 * tainted turn (companion_session_send, w2-fix D3). send_to_thread asks
 * through its own requestApproval, which its MCP registration forces in such
 * a turn.
 */
const SELF_ASKING: ReadonlySet<string> = new Set([
  'start_conversation', 'create_scheduled_job', 'update_scheduled_job', 'run_scheduled_job', 'delete_scheduled_job',
  'companion_session_send',
]);

/** Why such a call asks, in the question the user sees. */
export const TAINTED_TOOL_ASK_REASON = 'This conversation read check-in material, so Michi asks before this runs.';

const RUN_LABEL = 'Run it';
const DECLINE_LABEL = "Don't run it";
const PREVIEW_CHARS = 600;
/** Chats whose running turn holds approvals the runtime gate gave; the oldest is dropped past this. */
const MAX_NODES = 256;

/** Per chat: the running turn, and how many calls of each gated tool the runtime gate approved in it and the dispatch has not run yet. */
const runtimeApprovals = new Map<string, { turnId: string; counts: Map<string, number> }>();

/** The bare name of a Michi tool this gate covers, under any runtime's name for it; null for anything else. */
function gatedName(toolName: string): string | null {
  const bare = typeof toolName === 'string' ? michiBareToolName(toolName) : null;
  if (!bare || SELF_ASKING.has(bare)) return null;
  const effect = michiToolEffect(bare);
  return effect === 'indirect' || effect === 'outside_write' ? bare : null;
}

/** Whether the dispatch checks calls of this tool (the gate below applies to it). */
export function taintGatedMichiTool(toolName: string): boolean {
  return gatedName(toolName) !== null;
}

function runningTurnId(nodeId: string): string | null {
  try {
    return activeTurnTrust(nodeId)?.turnId ?? null;
  } catch {
    return null;
  }
}

/**
 * The permission port's note (agents/chatApprovalState.ts): the user
 * approved one call of `toolName` in this chat's running turn through
 * Michi's approval prompt. Kept for that turn only; never throws.
 */
export function noteRuntimeToolApproval(nodeId: string, toolName: string): void {
  try {
    const bare = gatedName(toolName);
    if (!bare || typeof nodeId !== 'string' || !nodeId) return;
    const turnId = runningTurnId(nodeId);
    if (!turnId) return;
    let entry = runtimeApprovals.get(nodeId);
    if (!entry || entry.turnId !== turnId) entry = { turnId, counts: new Map() };
    runtimeApprovals.delete(nodeId);
    runtimeApprovals.set(nodeId, entry);
    entry.counts.set(bare, (entry.counts.get(bare) ?? 0) + 1);
    while (runtimeApprovals.size > MAX_NODES) runtimeApprovals.delete(runtimeApprovals.keys().next().value!);
  } catch (err) {
    log.warn('chat', 'runtime tool approval not noted; the tool asks again', { nodeId, toolName, error: err instanceof Error ? err.message : String(err) });
  }
}

/** Takes one approval the runtime gate gave this chat's running turn for `bare`; false when there is none. */
function takeRuntimeToolApproval(nodeId: string, bare: string): boolean {
  const entry = runtimeApprovals.get(nodeId);
  if (!entry) return false;
  if (entry.turnId !== runningTurnId(nodeId)) {
    runtimeApprovals.delete(nodeId);
    return false;
  }
  const count = entry.counts.get(bare) ?? 0;
  if (count <= 0) return false;
  if (count === 1) entry.counts.delete(bare);
  else entry.counts.set(bare, count - 1);
  return true;
}

export type TaintedToolGate = { kind: 'run' } | { kind: 'ask'; reason: string };

const RUN: TaintedToolGate = Object.freeze({ kind: 'run' });

/**
 * Whether a Michi tool call from this chat may run as it is, or must ask the
 * user first: it asks when the tool is gated (taintGatedMichiTool), the
 * chat's running turn holds check-in or collector material, and Michi's
 * runtime gate did not already approve this call (one approval answers one
 * call). A taint that cannot be read counts as one (activeCompanionTaint).
 */
export function taintedMichiToolGate(nodeId: string | null | undefined, toolName: string): TaintedToolGate {
  const bare = gatedName(toolName);
  if (!bare || typeof nodeId !== 'string' || !nodeId) return RUN;
  if (activeCompanionTaint(nodeId) === null) return RUN;
  if (takeRuntimeToolApproval(nodeId, bare)) return RUN;
  return { kind: 'ask', reason: TAINTED_TOOL_ASK_REASON };
}

type AskUser = (questions: Array<{
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}>) => Promise<Record<string, string> | null>;

type ToolTextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function preview(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args ?? {}, null, 1) ?? '{}';
  } catch {
    text = String(args);
  }
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

/**
 * Asks the user, through the slot's ask_user channel, whether this one call
 * may run; null when it may (the exact "Run it" answer), otherwise the
 * tool's answer to the agent: declined (with what the user typed), or
 * refused when there is no channel to ask through.
 */
export async function askBeforeTaintedTool(askUser: AskUser | undefined, toolName: string, args: unknown, reason: string): Promise<ToolTextResult | null> {
  if (!askUser) {
    return {
      content: [{ type: 'text', text: `NEEDS_USER_APPROVAL: this conversation read check-in material, so ${toolName} runs only with the user's approval, `
        + `and Michi cannot ask for it from here; it did not run. Do not retry. Ask the user in chat: say what you wanted it to do and why, and let them decide.` }],
      isError: true,
    };
  }
  const question = `Run ${toolName}?\n${reason}\n\n${preview(args)}`;
  const answers = await askUser([{
    question,
    header: 'Run tool',
    options: [
      { label: RUN_LABEL, description: 'Run this one call.' },
      { label: DECLINE_LABEL, description: 'Nothing runs; the agent is told you declined.' },
    ],
    multiSelect: false,
  }]);
  const answer = answers ? (answers[question] ?? Object.values(answers)[0] ?? '').trim() : null;
  if (answer === RUN_LABEL) return null;
  const note = answer && answer !== DECLINE_LABEL ? answer.slice(0, 500) : null;
  return {
    content: [{ type: 'text', text: JSON.stringify({
      status: 'declined',
      tool: toolName,
      ...(note ? { userNote: note } : {}),
      next: answer === null
        ? 'The user did not answer; nothing ran. Do not retry unless the user asks.'
        : 'The user declined; nothing ran. Do not retry unless the user asks.',
    }) }],
  };
}

/**
 * Forgets every approval the runtime gate noted.
 * @testonly
 */
export function __resetRuntimeToolApprovals(): void {
  runtimeApprovals.clear();
}
