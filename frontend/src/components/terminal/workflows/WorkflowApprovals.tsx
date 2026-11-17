import React from 'react';
import type { WorkflowApprovalDto, WorkflowRunDtoV1 } from 'michi-shared';
import { workflowApprovalSource } from './workflowPresentation';
import './WorkflowRunCard.css';

/**
 * Tool approvals a workflow's steps wait on, answered in place. Mirrors the
 * chat permission card: a select-tinted rule, the request, its detail in
 * mono, and one button per option (allow first, reject quiet). Without a way
 * to answer, the request still shows, without its buttons.
 */

const MONO = 'var(--font-mono)';

/** An answer's weight: the first is the one to give, a rejection stays quiet. */
function optionVariant(kind: string | undefined, primary: boolean): 'reject' | 'primary' | undefined {
  if (kind?.startsWith('reject')) return 'reject';
  return primary ? 'primary' : undefined;
}

function ApprovalRow({ run, approval, busy, onAnswer }: {
  run: WorkflowRunDtoV1;
  approval: WorkflowApprovalDto;
  busy: boolean;
  onAnswer?: (approvalId: string, optionId: string) => void;
}) {
  const source = workflowApprovalSource(run, approval);
  return (
    <div
      role="group"
      aria-label={`Approval needed: ${approval.title}`}
      data-testid="workflow-approval"
      style={{ borderLeft: '2px solid var(--term-select)', background: 'var(--term-alt)', padding: '7px 10px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, color: 'var(--term-fg)' }}>{approval.title}</span>
        {source.label && <span title={source.title} style={{ fontFamily: MONO, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>{source.label}</span>}
      </div>
      {approval.detail && (
        <pre className="term-scrollbar" style={{ margin: 0, maxHeight: 140, overflow: 'auto', fontFamily: MONO, fontSize: 'var(--fs-xs)', lineHeight: 1.5, color: 'var(--term-mid)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {approval.detail}
        </pre>
      )}
      {onAnswer && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {approval.options.map((option, index) => (
            <button
              key={option.optionId}
              type="button"
              disabled={busy}
              className="workflow-approval-option"
              data-variant={optionVariant(option.kind, index === 0)}
              onClick={() => onAnswer(approval.id, option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkflowApprovals({ run, busy = false, onAnswer }: {
  run: WorkflowRunDtoV1;
  busy?: boolean;
  onAnswer?: (approvalId: string, optionId: string) => void;
}) {
  const approvals = run.approvals ?? [];
  if (approvals.length === 0) return null;
  return (
    <div data-testid="workflow-approvals" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {approvals.map((approval) => (
        <ApprovalRow key={approval.id} run={run} approval={approval} busy={busy} onAnswer={onAnswer} />
      ))}
    </div>
  );
}
