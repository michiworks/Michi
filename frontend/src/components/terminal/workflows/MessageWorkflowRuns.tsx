import React, { useId, useMemo, useRef, useState } from 'react';
import type { WorkflowRunStatus } from 'michi-shared';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import {
  useFinishedWorkflowRuns,
  useOptionalWorkflowDomain,
  useWorkflowRun,
  workflowRunKey,
  type WorkflowPlacement,
} from '../../../state/workflowDomain';
import { FadeOnChange, Reveal, RevealList, RevealOnShow, type RevealRow } from '../agentBlockMotion';
import { CheckIcon, ChevronRightIcon, WorkflowIcon } from '../icons';
import { WORKFLOW_CHIP, WORKFLOW_STATUS_LABEL, workflowElapsedLabel } from './workflowPresentation';
import { WorkflowRunCard } from './WorkflowRunCard';

type OpenRun = (identity: AgentResourceIdentity, name: string) => void;

/**
 * One card, subscribed to its own run so other runs' progress skips it. A run
 * read after the card mounted grows in under a message made on screen (`enter`).
 */
const ConnectedWorkflowRunCard = React.memo(function ConnectedWorkflowRunCard({ identity, onOpen, enter }: {
  identity: AgentResourceIdentity;
  onOpen?: OpenRun;
  enter: boolean;
}) {
  const domain = useOptionalWorkflowDomain();
  const { resource, pending, error } = useWorkflowRun(workflowRunKey(identity));
  return (
    <RevealOnShow show={!!resource} enter={enter}>
      {resource && (
        <WorkflowRunCard
          run={resource.value}
          pending={pending}
          error={error}
          onAnswer={domain ? (approvalId, optionId) => { void domain.answer(identity, approvalId, optionId); } : undefined}
          onOpen={onOpen ? () => onOpen(identity, resource.value.name) : undefined}
        />
      )}
    </RevealOnShow>
  );
});

/** A message's finished runs fold into one line once it has this many, or at once when one failed. */
const FOLD_AT = 2;

/** The fold line's counts, in this order, each named for how its runs ended. */
const FOLD_COUNTS: ReadonlyArray<{ status: WorkflowRunStatus; label: string; color?: string }> = [
  { status: 'completed', label: 'done' },
  { status: 'failed', label: 'failed', color: 'var(--term-danger-text)' },
  { status: 'cancelled', label: 'stopped' },
];

/** A folded run as one line; a click opens the run, as its card would. */
function FoldedRunRow({ identity, onOpen }: { identity: AgentResourceIdentity; onOpen?: OpenRun }) {
  const { resource } = useWorkflowRun(workflowRunKey(identity));
  if (!resource) return null;
  const run = resource.value;
  const chip = WORKFLOW_CHIP[run.status];
  const content = (
    <>
      <span className="workflow-fold__name">{run.name}</span>
      <span className="workflow-fold__status" style={{ color: chip.color }}>{chip.label}</span>
      <span className="workflow-fold__time">{workflowElapsedLabel(run)}</span>
      {onOpen && <span aria-hidden className="workflow-fold__open">›</span>}
    </>
  );
  return (
    <li>
      {onOpen ? (
        <button
          type="button"
          className="workflow-fold__row"
          aria-label={`Open workflow ${run.name}, ${WORKFLOW_STATUS_LABEL[run.status]}`}
          onClick={() => onOpen(identity, run.name)}
        >
          {content}
        </button>
      ) : (
        <div className="workflow-fold__row">{content}</div>
      )}
    </li>
  );
}

/**
 * A message's finished runs as one line of counts: "⧉ WORKFLOWS ✓ 5 done ·
 * 1 stopped ⌄". The chevron lists them, one line each; a line opens its run.
 */
function FinishedWorkflowRuns({ runs, finished, onOpen }: {
  runs: readonly WorkflowPlacement[];
  finished: ReadonlyMap<string, WorkflowRunStatus>;
  onOpen?: OpenRun;
}) {
  const [open, setOpen] = useState(false);
  const openedByClickRef = useRef(false);
  const listId = useId();
  const ended = [...finished.values()];
  const parts = FOLD_COUNTS
    .map((group) => ({ ...group, count: ended.filter((status) => status === group.status).length }))
    .filter((group) => group.count > 0);
  return (
    <section className="workflow-fold" aria-label={`${runs.length} finished workflows`}>
      <button
        type="button"
        className="workflow-fold__head"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`Workflows: ${parts.map((part) => `${part.count} ${part.label}`).join(', ')}`}
        onClick={() => { openedByClickRef.current = !open; setOpen(!open); }}
      >
        <span className="workflow-run-card__eyebrow">
          <WorkflowIcon size="sm" className="workflow-run-card__icon" />
          Workflows
        </span>
        <span className="workflow-fold__counts">
          {parts.map((part, index) => (
            <React.Fragment key={part.status}>
              {index > 0 && <span aria-hidden className="workflow-fold__sep">·</span>}
              {/* A count that changes fades to its new value. */}
              <FadeOnChange k={`${part.status}:${part.count}`} style={{ color: part.color }}>
                {part.status === 'completed' && <CheckIcon size="sm" className="workflow-fold__check" />}
                <span className="workflow-fold__count">{part.count}</span> {part.label}
              </FadeOnChange>
            </React.Fragment>
          ))}
        </span>
        <span aria-hidden className="workflow-fold__chevron"><ChevronRightIcon size="sm" /></span>
      </button>
      <div id={listId}>
        <Reveal show={open} preset="group" scrollOnOpen={openedByClickRef}>
          <ul className="workflow-fold__list">
            {runs.map((placement) => (
              <FoldedRunRow key={workflowRunKey(placement.identity)} identity={placement.identity} onOpen={onOpen} />
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

/**
 * Workflow runs a message launched, under its body and above its action row.
 * Live runs keep their cards. Once FOLD_AT have finished, or one failed, the
 * finished ones fold into one line above the cards: a card that finishes
 * collapses out as the line grows in or recounts. The line's red count keeps
 * a failure in view, and the message's text says what went wrong.
 */
export function MessageWorkflowRuns({ runs, onOpen, enter = false }: {
  runs: readonly WorkflowPlacement[];
  onOpen?: OpenRun;
  /** The message was made on screen: a card whose run is read later grows in. */
  enter?: boolean;
}) {
  const keys = useMemo(() => runs.map((placement) => workflowRunKey(placement.identity)), [runs]);
  const finished = useFinishedWorkflowRuns(keys);
  const fold = finished.size >= FOLD_AT || [...finished.values()].includes('failed');
  const rows: RevealRow[] = [];
  if (fold) {
    const folded = runs.filter((_, index) => finished.has(keys[index]));
    rows.push({ key: 'finished', node: <FinishedWorkflowRuns runs={folded} finished={finished} onOpen={onOpen} /> });
  }
  runs.forEach((placement, index) => {
    if (fold && finished.has(keys[index])) return;
    rows.push({ key: keys[index], node: <ConnectedWorkflowRunCard identity={placement.identity} onOpen={onOpen} enter={enter} /> });
  });
  return (
    <div style={{ margin: '10px 0 6px' }}>
      <RevealList rows={rows} gap={6} />
    </div>
  );
}
