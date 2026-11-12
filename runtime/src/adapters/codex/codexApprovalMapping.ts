// How CodexSession maps Codex's approval and user-input server requests onto
// Michi's events and back onto Codex's responses. Pure; the session keeps the
// pending requests, their timers and the decision of which path a request takes.
import type { RuntimePermissionDecision } from '../../contract/types';
import type { NormalizedEvent, PermissionOption, UserInputQuestion } from '../../contract/events';
import { permissionDetail } from '../../core/permissionPrompt';

/**
 * Codex's canonical permission tool name for an approval method, used for
 * display, chat grants and the Run permission broker. Command and file
 * approvals are the only methods routed here; they map onto bash and edit.
 */
export function canonicalToolNameFromMethod(method: string): string {
  if (method === 'item/commandExecution/requestApproval') return 'bash';
  if (method === 'item/fileChange/requestApproval') return 'edit';
  // Unknown methods — use the last segment
  const parts = method.split('/');
  return parts[parts.length - 1] ?? method;
}

/**
 * The canonical form under which one chat approval covers another request
 * (ApprovalCoordinator.covers). The names canonicalToolNameFromMethod gives
 * the routed approvals, bash and edit, are already the host's grant keys.
 */
export function codexGrantToolName(toolName: string): string {
  return toolName;
}

/** The permission request a Codex approval shows the user. */
export function codexPermissionRequest(
  requestId: number,
  method: string,
  params: Record<string, unknown>,
  toolName: string,
  options: PermissionOption[],
): NormalizedEvent {
  return {
    kind: 'permission_request',
    requestId,
    title: `Approve ${toolName}?`,
    detail: permissionDetail(canonicalToolNameFromMethod(method), params),
    options,
    source: 'codex_approval',
  };
}

/** The options an Agent Run's broker "ask" offers: no grant is ever persisted. */
export function codexRunAskOptions(): PermissionOption[] {
  return [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
  ];
}

/**
 * Codex's decision for an Agent Run broker decision, or null when the broker
 * says "ask" (or anything else) and the user is asked instead.
 */
export function codexBrokerDecision(decision: RuntimePermissionDecision): 'accept' | 'acceptForSession' | 'decline' | null {
  switch (decision) {
    case 'allow_once':
      return 'accept';
    case 'allow_always':
      // Attempt-scoped allow → acceptForSession; no grant is persisted.
      return 'acceptForSession';
    case 'deny':
      return 'decline';
    case 'ask':
    default:
      return null;
  }
}

/** The questions of a `requestUserInput` request, or null when it must be answered with no answers. */
export function codexUserInputQuestions(params: Record<string, unknown>): UserInputQuestion[] | null {
  const questions: Record<string, unknown>[] = Array.isArray(params.questions) ? params.questions : [];
  // The generic question UI persists answers and is not a secret-input surface.
  // Do not downgrade a secret prompt to a normal text field.
  if (questions.some((q) => !q || typeof q.id !== 'string' || q.isSecret === true)
    || new Set(questions.map((q) => q.id)).size !== questions.length) {
    return null;
  }
  return questions.map((q: Record<string, unknown>) => ({
    id: q.id as string,
    question: String(q.question ?? ''),
    header: typeof q.header === 'string' ? q.header : undefined,
    options: Array.isArray(q.options)
      ? (q.options as Array<Record<string, unknown>>).map((o) => ({
          label: String(o.label ?? ''),
          description: typeof o.description === 'string' ? o.description : undefined,
        }))
      : [],
    multiSelect: false,
  }));
}
