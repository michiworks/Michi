import { BACKEND_RESTARTED_ERROR, turnInterruptionCause, type TurnInterruptionCause } from 'michi-shared';
import { assistantAnswerVisibleText } from './assistantBlocks';
import type { ChatMessage } from './chatTypes';

/** The stream error code and `turns.error` marker of a turn a Michi restart cut short. */
export const BACKEND_RESTARTED_KIND = BACKEND_RESTARTED_ERROR;

/**
 * The error kind of a turn the agent's credentials expiring cut short (an
 * expired Auth session, say), classified from its message: the stored
 * receipt keeps only the text, and runtimes word it their own way.
 */
export const CREDENTIALS_EXPIRED_KIND = 'credentials_expired';

/** A turn's error kind, with a credentials failure the stream sent no code for named as one. */
export function classifiedErrorKind(code: string | undefined, message: string): string | undefined {
  if (code) return code;
  return turnInterruptionCause(message) === 'credentials' ? CREDENTIALS_EXPIRED_KIND : undefined;
}

/** Why the node's last turn was interrupted, from its error kind; null when it was not. */
export function interruptionCauseOfKind(errorKind: string | undefined): TurnInterruptionCause | null {
  if (errorKind === BACKEND_RESTARTED_KIND) return 'restart';
  return errorKind === CREDENTIALS_EXPIRED_KIND || errorKind === 'auth' ? 'credentials' : null;
}

export { BACKEND_RESTARTED_MESSAGE } from 'michi-shared';

/** The user row a Resume lands as; the wire text is the continuation prompt. */
const RESUME_DISPLAY_TEXT = 'Resume the interrupted turn';

const RESUME_REQUEST_CAP = 8_000;
const RESUME_PARTIAL_CAP = 4_000;
const RESUME_TOOL_CALL_CAP = 12;
const RESUME_TOOL_INPUT_CAP = 160;

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}… [truncated]` : text;
}

const INTERRUPTION_LINE: Record<TurnInterruptionCause, string> = {
  restart: 'The turn below was cut off when Michi restarted, so the agent session may not contain it. ',
  credentials: 'The turn below was cut off when the agent\'s credentials expired, so the agent session may not contain all of it. ',
};

/**
 * The prompt a Resume sends after a restart (or expired credentials) cut the last turn short.
 *
 * kiro-cli records a prompt in its session log only once the model has
 * answered it, so the interrupted request and whatever streamed back are
 * missing from the resumed native session. The prompt restores both, lists
 * the tool calls the journal saw (the last one may have been mid-flight), and
 * asks for a continuation: never re-run finished steps, never assume progress.
 * Mid-turn steering rows are carried in order as part of the partial output.
 * Returns null when the transcript holds no request to carry on with.
 */
export function buildResumePrompt(
  messages: ChatMessage[],
  cause: TurnInterruptionCause = 'restart',
): { text: string; displayText: string } | null {
  const openerIdx = messages.findLastIndex((m) => m.role === 'user' && !m.steered);
  if (openerIdx < 0) return null;
  const request = clip(messages[openerIdx].text.trim(), RESUME_REQUEST_CAP);
  if (!request) return null;
  const partial: string[] = [];
  const tools: string[] = [];
  for (const m of messages.slice(openerIdx + 1)) {
    if (m.role === 'user') {
      const steer = m.text.trim();
      if (steer) partial.push(`[Steered mid-turn] ${clip(steer, RESUME_REQUEST_CAP)}`);
      continue;
    }
    const answer = assistantAnswerVisibleText(m).trim();
    if (answer) partial.push(answer);
    for (const tool of m.toolCalls) {
      const input = tool.inputJson?.trim();
      tools.push(`- ${tool.title || tool.kind || tool.id} [${tool.status}]${input ? `: ${clip(input, RESUME_TOOL_INPUT_CAP)}` : ''}`);
    }
  }
  const lines = [
    '[INTERRUPTED TURN — context restore]',
    INTERRUPTION_LINE[cause]
      + 'It is the user\'s most recent request, the one you are being asked to carry on with. '
      + 'Tool calls it made may already have taken effect.',
    '',
    `Interrupted request:\n${request}`,
  ];
  if (partial.length > 0) lines.push('', `Partial response before the interruption:\n${clip(partial.join('\n'), RESUME_PARTIAL_CAP)}`);
  if (tools.length > 0) {
    const omitted = tools.length - RESUME_TOOL_CALL_CAP;
    lines.push('', 'Tool calls recorded before the interruption (in order; the last one may not have finished):');
    if (omitted > 0) lines.push(`- … ${omitted} earlier tool call${omitted === 1 ? '' : 's'} omitted`);
    lines.push(...tools.slice(-RESUME_TOOL_CALL_CAP));
  }
  lines.push(
    '[END INTERRUPTED TURN]',
    '',
    'The user pressed Resume. Look at the conversation above, work out what was already completed, '
      + 'and finish the user\'s most recent request from there. Do NOT re-run steps or tools that already '
      + 'completed successfully, and do NOT assume any particular progress was made — if nothing was done yet, '
      + 'simply start the request now.',
  );
  return { text: lines.join('\n'), displayText: RESUME_DISPLAY_TEXT };
}
