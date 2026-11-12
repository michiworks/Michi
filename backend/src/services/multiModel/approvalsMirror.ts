/**
 * A branch's pending permission request, hosted on its multi-model run
 * (run.approvals), so the card and the drawer can answer it without opening
 * the branch. One mirror per thread: a new request supersedes the earlier
 * one, and an answer anywhere withdraws it.
 */
import { multiModelLeafId, type ChatStreamEnvelope, type ChatStreamPayloads, type WorkflowApprovalOption } from 'michi-shared';
import type { PermissionAnswer, PermissionAnswerResult } from '../chatPermissionAnswers';
import type { WorkflowRunHub } from '../workflowRunHub';

export interface ApprovalMirrorDeps {
  hub: Pick<WorkflowRunHub, 'requestApproval' | 'withdrawApproval'>;
  getPendingPermission(chatId: string): (ChatStreamPayloads['permission_request'] & ChatStreamEnvelope) | null;
  answer(chatId: string, userId: string | null, answer: PermissionAnswer): PermissionAnswerResult;
}

export interface ApprovalMirrorTarget {
  ownerUserId: string;
  nativeId: string;
  threadKey: string;
  /** The step's index: the approval attaches to the `<threadKey>@<step>` leaf. */
  step: number;
  childNodeId: string;
  turnId: string;
}

interface Mirrored {
  ownerUserId: string;
  approvalId: string;
}

export class MultiModelApprovalMirror {
  /** nativeId → threadKey → the approval hosted for it. */
  private readonly mirrored = new Map<string, Map<string, Mirrored>>();

  constructor(private readonly deps: ApprovalMirrorDeps) {}

  /** Host the child's current pending permission on the run; supersedes the thread's earlier mirror. Returns the approval id. */
  mirror(target: ApprovalMirrorTarget): string | null {
    const pending = this.deps.getPendingPermission(target.childNodeId);
    // The turn check also filters requests replayed on subscribe.
    if (!pending || pending.turnId !== target.turnId) return null;
    const approvalId = `${target.threadKey}:${target.turnId}:${pending.requestId}`;
    const current = this.mirrored.get(target.nativeId)?.get(target.threadKey);
    if (current?.approvalId === approvalId) return approvalId;
    this.withdraw(target.nativeId, target.threadKey);
    const allow = pending.options.find((option) => option.kind === 'allow_once' && !option.disabled);
    const reject = pending.options.find((option) => option.kind === 'reject_once' && !option.disabled);
    // Without both, the row links to the branch instead.
    if (!allow || !reject) return null;
    const options: WorkflowApprovalOption[] = [
      { optionId: allow.optionId, name: 'Allow once', kind: 'allow_once' },
      { optionId: reject.optionId, name: 'Deny', kind: 'reject_once' },
    ];
    const permUser = process.env.MICHI_CLOUD === '1' ? target.ownerUserId : null;
    const requestId = pending.requestId;
    const hosted = this.deps.hub.requestApproval(target.ownerUserId, 'michi', target.nativeId, {
      id: approvalId,
      nodeId: multiModelLeafId(target.threadKey, target.step),
      title: pending.title,
      ...(pending.detail ? { detail: pending.detail } : {}),
      options,
    }, (optionId) => {
      this.forget(target.nativeId, target.threadKey, approvalId);
      // null: the run ended; Stop all cancels the turn. A 409 was answered elsewhere.
      if (optionId !== null) this.deps.answer(target.childNodeId, permUser, { requestId, optionId });
    });
    if (!hosted) return null;
    let threads = this.mirrored.get(target.nativeId);
    if (!threads) {
      threads = new Map();
      this.mirrored.set(target.nativeId, threads);
    }
    threads.set(target.threadKey, { ownerUserId: target.ownerUserId, approvalId });
    return approvalId;
  }

  /** Withdraw the thread's mirror (answered in the pane, resolved, turn ended, new turn). */
  withdraw(nativeId: string, threadKey: string): void {
    const current = this.mirrored.get(nativeId)?.get(threadKey);
    if (!current) return;
    this.forget(nativeId, threadKey, current.approvalId);
    this.deps.hub.withdrawApproval(current.ownerUserId, 'michi', nativeId, current.approvalId);
  }

  withdrawAll(nativeId: string): void {
    for (const threadKey of [...(this.mirrored.get(nativeId)?.keys() ?? [])]) this.withdraw(nativeId, threadKey);
  }

  private forget(nativeId: string, threadKey: string, approvalId: string): void {
    const threads = this.mirrored.get(nativeId);
    if (threads?.get(threadKey)?.approvalId !== approvalId) return;
    threads.delete(threadKey);
    if (threads.size === 0) this.mirrored.delete(nativeId);
  }
}
