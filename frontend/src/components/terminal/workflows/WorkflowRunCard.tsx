import React from 'react';
import { isWorkflowRunTerminal, isWorkflowWorkNode, workflowProgress, type WorkflowAction, type WorkflowRunDtoV1 } from 'michi-shared';
import {
  ACTION_LABEL,
  NODE_STATUS_COLOR,
  RUNTIME_LABEL,
  RUN_NOUN,
  WORKFLOW_CHIP,
  WORKFLOW_NEEDS_YOU_CHIP,
  WORKFLOW_STATUS_LABEL,
  formatWorkflowTokens,
  workflowElapsedLabel,
  workflowNow,
} from './workflowPresentation';
import { WorkflowApprovals } from './WorkflowApprovals';
import type { WorkflowPendingKind } from '../../../state/workflowDomain';
import { FadeOnChange, RevealOnShow } from '../agentBlockMotion';
import { useNow } from '../../../hooks/useNow';
import { cardClickOpens } from '../../../lib/cardClick';
import './runChip.css';
import './WorkflowRunCard.css';

/**
 * A workflow launched by this message, under the chip that launched it.
 * Same rounded card and status chip as the drawer's run card: a WORKFLOW
 * eyebrow with the status and elapsed time, the name on its own lines, a
 * progress strip of the run's agents/steps, the live "now" strip, and a
 * footer. The card carries no run controls (they live in the run's detail);
 * a click anywhere on it opens the run, and its › is the keyboard target.
 */

const textButton: React.CSSProperties = {
  border: 0,
  padding: 0,
  background: 'transparent',
  font: 'inherit',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export function WorkflowActions({ run, pending, onAction }: {
  run: WorkflowRunDtoV1;
  pending?: WorkflowPendingKind;
  onAction?: (action: WorkflowAction) => void;
}) {
  if (!onAction || run.actions.length === 0) return null;
  return (
    <>
      {run.actions.map((action) => (
        <button
          key={action}
          type="button"
          disabled={!!pending}
          onClick={() => onAction(action)}
          aria-label={`${ACTION_LABEL[action]} workflow ${run.name}`}
          className="t-hover-fg"
          style={{ ...textButton, color: action === 'stop' ? 'var(--term-mid)' : 'var(--term-muted)', opacity: pending && pending !== action ? 0.5 : 1 }}
        >
          {pending === action ? `${ACTION_LABEL[action]}…` : ACTION_LABEL[action]}
        </button>
      ))}
    </>
  );
}

/** One cell per agent/step, colored by status (a change eases in); hover names it. */
function ProgressRow({ run }: { run: WorkflowRunDtoV1 }) {
  const leaves = run.nodes.filter(isWorkflowWorkNode);
  if (leaves.length === 0) return null;
  const progress = workflowProgress(run);
  return (
    <div className="workflow-run-card__progress">
      <div aria-hidden className="workflow-run-card__segments">
        {leaves.slice(0, 48).map((node) => (
          <span
            key={node.id}
            title={`${node.title} · ${node.status}`}
            className={node.status === 'running' ? 'workflow-run-card__segment term-dot-i--run' : 'workflow-run-card__segment'}
            style={{
              background: node.status === 'queued' || node.status === 'skipped' ? 'var(--term-line)' : NODE_STATUS_COLOR[node.status],
              opacity: node.status === 'completed' ? 0.55 : 1,
            }}
          />
        ))}
      </div>
      <span className="workflow-run-card__count">
        <b>{progress.done}</b>/{progress.total} {RUN_NOUN[run.runtime]}
        {progress.failed > 0 && <span style={{ color: 'var(--term-danger-text)' }}> · {progress.failed} failed</span>}
      </span>
    </div>
  );
}

export function WorkflowRunCard({ run, pending, error, onOpen, onAnswer }: {
  run: WorkflowRunDtoV1;
  pending?: WorkflowPendingKind;
  error?: string;
  onOpen?: () => void;
  onAnswer?: (approvalId: string, optionId: string) => void;
}) {
  const live = !isWorkflowRunTerminal(run.status);
  const now = useNow(1_000, live);
  const doing = workflowNow(run);
  const needsYou = !!run.approvals?.length;
  const chip = needsYou ? WORKFLOW_NEEDS_YOU_CHIP : WORKFLOW_CHIP[run.status];
  const tokens = formatWorkflowTokens(run.usage?.totalTokens);
  return (
    <article
      data-testid="workflow-run-card"
      aria-label={`Workflow ${run.name}, ${needsYou ? 'needs approval' : WORKFLOW_STATUS_LABEL[run.status]}`}
      className={onOpen ? 'workflow-run-card workflow-run-card--opens' : 'workflow-run-card'}
      // A tap here opens the run; it does not reveal the message's actions (MessageBlock's TAP_CONTROL).
      data-tap-target={onOpen ? 'true' : undefined}
      onClick={onOpen ? (event) => { if (cardClickOpens(event)) onOpen(); } : undefined}
    >
      <div className="workflow-run-card__top">
        <span className="workflow-run-card__eyebrow">
          <span aria-hidden className="workflow-run-card__icon">⧉</span>
          Workflow
        </span>
        {/* A new status fades in in its colour; sections that appear later grow in. */}
        <FadeOnChange
          k={needsYou ? 'needs-you' : run.status}
          className="run-chip"
          style={{ color: chip.color, background: chip.fill }}
        >
          {live ? <span className={run.status === 'running' && !needsYou ? 'term-dot-i term-dot-i--run' : 'term-dot-i'} aria-hidden /> : null}
          {chip.label}
          <span className="run-chip__time">{workflowElapsedLabel(run, now)}</span>
        </FadeOnChange>
      </div>
      <h3 className="workflow-run-card__title">{run.name}</h3>
      {run.description && run.description !== run.name && (
        <p className="workflow-run-card__description">{run.description}</p>
      )}
      <ProgressRow run={run} />
      <RevealOnShow show={!!doing}>
        <div data-testid="workflow-now" className="workflow-run-card__now">
          <span aria-hidden className="workflow-run-card__caret">❯</span>
          {doing?.step && <span data-testid="workflow-now-step" className="workflow-run-card__step">{doing.step}</span>}
          <span className="workflow-run-card__doing" style={run.status === 'paused' ? { color: 'var(--term-select)' } : undefined}>{doing?.detail}</span>
        </div>
      </RevealOnShow>
      <RevealOnShow show={needsYou}>
        <div data-card-click="ignore" style={{ marginTop: 10 }}><WorkflowApprovals run={run} busy={pending === 'answer'} onAnswer={onAnswer} /></div>
      </RevealOnShow>
      <RevealOnShow show={!live && !!run.statusDetail && run.status !== 'completed'}>
        <p className="workflow-run-card__detail" style={{ color: run.status === 'failed' ? 'var(--term-danger-text)' : 'var(--term-muted)' }}>{run.statusDetail}</p>
      </RevealOnShow>
      <RevealOnShow show={!!error}>
        <div role="alert" className="workflow-run-card__detail" style={{ fontSize: 'var(--fs-xs)', color: 'var(--term-danger-text)' }}>{error}</div>
      </RevealOnShow>
      <div className="workflow-run-card__foot">
        <span>{RUNTIME_LABEL[run.runtime]}</span>
        {tokens && (<><span aria-hidden className="workflow-run-card__sep">·</span><span className="workflow-run-card__mono">{tokens}</span></>)}
        {onOpen && (
          <button type="button" onClick={onOpen} aria-label={`Open workflow ${run.name}`} className="workflow-run-card__open">
            <span aria-hidden>›</span>
          </button>
        )}
      </div>
    </article>
  );
}
