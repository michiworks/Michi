/**
 * The prompt that carries on a turn that ended before it finished, without
 * sending its request again (a second run would repeat the tool calls the
 * first one completed). The frontend's Resume and Continue
 * (state/turnInterruption.ts) and Michi's automatic continuation (backend
 * services/autoContinue.ts) build it from their own transcripts.
 *
 * When the agent session may be missing the turn (Michi restarted, the
 * credentials expired, the user stopped it, it failed), the prompt restores
 * the request, what streamed back and the tool calls it saw: kiro-cli
 * records a prompt in its session log only once the model has answered it.
 * A turn that completed early (its output or step limit) is whole in the
 * session, so it only asks to carry on.
 */

import type { TurnInterruptionCause } from './interruptedTurns';
import type { AutoContinueReason, TurnEndMark } from './turnEnd';

export type TurnContinuationCause = TurnInterruptionCause | TurnEndMark | Exclude<AutoContinueReason, 'max_tokens' | 'max_turn_requests'>;

/** Who carries the turn on: the user's Resume or Continue, or Michi by itself. */
export type TurnContinuationBy = 'resume' | 'continue' | 'auto';

/** A transcript message, as either side holds it. */
export interface ContinuationMessage {
  role: 'user' | 'assistant';
  /** A user message's text, or an assistant message's visible answer. */
  text: string;
  /** Sent into the running turn, not a request of its own. */
  steered?: boolean;
  /** Michi's automatic continuation: it carries the request before it on and is never the request. */
  autoContinue?: boolean;
  toolCalls?: ReadonlyArray<{ id: string; title?: string; kind?: string; status: string; inputJson?: string }>;
}

const REQUEST_CAP = 8_000;
const PARTIAL_CAP = 4_000;
const TOOL_CALL_CAP = 12;
const TOOL_INPUT_CAP = 160;

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}… [truncated]` : text;
}

const RESTORE_LINE: Record<Exclude<TurnContinuationCause, 'max_tokens' | 'max_turn_requests' | 'refusal'>, string> = {
  restart: 'The turn below was cut off when Michi restarted, so the agent session may not contain it. ',
  credentials: 'The turn below was cut off when the agent\'s credentials expired, so the agent session may not contain all of it. ',
  stopped: 'The turn below was stopped before it finished, so the agent session may not contain all of it. ',
  transient: 'The turn below failed on a temporary error, so the agent session may not contain all of it. ',
  connection: 'The turn below failed when the connection to the agent dropped, so the agent session may not contain all of it. ',
  quota: 'The turn below failed when the agent reached a usage or rate limit, so the agent session may not contain all of it. ',
};

const ENDED_EARLY_LINE: Record<'max_tokens' | 'max_turn_requests' | 'refusal', string> = {
  max_tokens: 'it reached its output limit',
  max_turn_requests: 'it reached its step limit',
  refusal: 'the agent declined to continue',
};

const BY_LINE: Record<TurnContinuationBy, string> = {
  resume: 'The user pressed Resume.',
  continue: 'The user pressed Continue.',
  auto: 'Michi continued it automatically.',
};

const endedEarly = (cause: TurnContinuationCause): cause is keyof typeof ENDED_EARLY_LINE => cause in ENDED_EARLY_LINE;

/**
 * The continuation prompt for the transcript's last turn. Steered rows are
 * carried in order as part of the partial output; Michi's automatic
 * continuations are never the request, so a chain of them carries on the
 * request that started it. Null when the transcript holds no request.
 */
export function buildContinuationPrompt(
  messages: readonly ContinuationMessage[],
  cause: TurnContinuationCause,
  by: TurnContinuationBy,
): string | null {
  let openerIdx = messages.length - 1;
  while (openerIdx >= 0 && !(messages[openerIdx].role === 'user' && !messages[openerIdx].steered && !messages[openerIdx].autoContinue)) openerIdx -= 1;
  if (openerIdx < 0) return null;
  const request = clip(messages[openerIdx].text.trim(), REQUEST_CAP);
  if (!request) return null;
  if (endedEarly(cause)) {
    return `Your previous turn stopped before it finished: ${ENDED_EARLY_LINE[cause]}. ${BY_LINE[by]} `
      + 'Carry on from where it stopped and finish the user\'s most recent request. Do NOT re-run steps or tools '
      + 'that already completed successfully, and do NOT start over. If the request is already done, say so briefly.';
  }
  const partial: string[] = [];
  const tools: string[] = [];
  for (const m of messages.slice(openerIdx + 1)) {
    if (m.role === 'user') {
      const steer = m.text.trim();
      if (steer && !m.autoContinue) partial.push(`[Steered mid-turn] ${clip(steer, REQUEST_CAP)}`);
      continue;
    }
    const answer = m.text.trim();
    if (answer) partial.push(answer);
    for (const tool of m.toolCalls ?? []) {
      const input = tool.inputJson?.trim();
      tools.push(`- ${tool.title || tool.kind || tool.id} [${tool.status}]${input ? `: ${clip(input, TOOL_INPUT_CAP)}` : ''}`);
    }
  }
  const lines = [
    '[INTERRUPTED TURN — context restore]',
    RESTORE_LINE[cause]
      + 'It is the user\'s most recent request, the one you are being asked to carry on with. '
      + 'Tool calls it made may already have taken effect.',
    '',
    `Interrupted request:\n${request}`,
  ];
  if (partial.length > 0) lines.push('', `Partial response before the interruption:\n${clip(partial.join('\n'), PARTIAL_CAP)}`);
  if (tools.length > 0) {
    const omitted = tools.length - TOOL_CALL_CAP;
    lines.push('', 'Tool calls recorded before the interruption (in order; the last one may not have finished):');
    if (omitted > 0) lines.push(`- … ${omitted} earlier tool call${omitted === 1 ? '' : 's'} omitted`);
    lines.push(...tools.slice(-TOOL_CALL_CAP));
  }
  lines.push(
    '[END INTERRUPTED TURN]',
    '',
    `${BY_LINE[by]} Look at the conversation above, work out what was already completed, `
      + 'and finish the user\'s most recent request from there. Do NOT re-run steps or tools that already '
      + 'completed successfully, and do NOT assume any particular progress was made — if nothing was done yet, '
      + 'simply start the request now.',
  );
  return lines.join('\n');
}
