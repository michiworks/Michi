import {
  AGENT_ATTEMPT_TERMINAL_STATUSES,
  AgentRunStatus,
  AgentRunWaitingReason,
  isValidAgentRunTransition,
  type AgentAttemptStatus,
} from 'michi-shared';

export { isAgentRunTerminal as isTerminalRunStatus } from 'michi-shared';

export function assertAgentRunTransition(from: AgentRunStatus, to: AgentRunStatus): void {
  if (!isValidAgentRunTransition(from, to)) {
    throw new Error(`invalid Agent Run transition: ${from} -> ${to}`);
  }
}

export function assertWaitingProjection(
  status: AgentRunStatus,
  waitingReason: AgentRunWaitingReason | null,
): void {
  if ((status === AgentRunStatus.Waiting) !== (waitingReason !== null)) {
    throw new Error('waitingReason must be set exactly while a Run is waiting');
  }
}

export function assertAttemptTransition(from: AgentAttemptStatus, to: AgentAttemptStatus): void {
  if (AGENT_ATTEMPT_TERMINAL_STATUSES.has(from)) throw new Error(`Attempt is already terminal as ${from}`);
  const allowed: Record<AgentAttemptStatus, ReadonlySet<AgentAttemptStatus>> = {
    preparing: new Set(['running', 'waiting', 'failed', 'cancelled']),
    running: new Set(['waiting', 'completed', 'failed', 'cancelled']),
    waiting: new Set(['running', 'failed', 'cancelled']),
    completed: new Set(), failed: new Set(), cancelled: new Set(),
  };
  if (!allowed[from].has(to)) throw new Error(`invalid Agent Run Attempt transition: ${from} -> ${to}`);
}
