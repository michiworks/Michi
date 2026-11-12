import React, { useCallback, useState } from 'react';
import {
  MULTI_MODEL_LIMITS,
  MULTI_MODEL_STEP_IN_FLIGHT,
  chatPermissionChoiceParts,
  plural,
  type MultiModelModelPick,
  type MultiModelPlanEdit,
  type MultiModelRunView,
  type MultiModelThreadView,
  type WorkflowApprovalDto,
  type WorkflowRunDtoV1,
} from 'michi-shared';
import { useChatNode, useOptionalChatActions } from '../../../state/chatStore';
import type { WorkflowPendingKind } from '../../../state/workflowDomain';
import type { AgentResourceIdentity } from '../../../state/agentIdentity';
import { workspaceBackendApiBase } from '../../../config/backendConnections';
import { effectiveChatPermissionChoice, usePermissionPreferences } from '../../../hooks/usePermissionPreferences';
import { formatMessageTime } from '../../../lib/messageTime';
import { useNow } from '../../../hooks/useNow';
import { cardClickOpens } from '../../../lib/cardClick';
import {
  addendumOutcome,
  approvalForRow,
  approvalKindWord,
  approvalText,
  branches,
  childNodeIds,
  collapsedSummary,
  defaultOpenStep,
  ENDED_ROW,
  fixesAtStep,
  formatDuration,
  isLongApproval,
  liveThreads,
  permissionText,
  runActions,
  RUN_CHIP_COLOR,
  runChip,
  stepIcon,
  stepLabel,
  stepProgress,
  stepStates,
  synthesisNote,
  threadActions,
  threadElapsed,
  type StepState,
} from './multiModelPresentation';
import { ModelGlyph, MultiModelModelPicker, useReadyModels } from './MultiModelModelPicker';
import { ColumnsIcon, ForkIcon } from '../icons';
import { useMultiModelCommands, type MultiModelCommands } from './useMultiModelCommands';
import '../workflows/runChip.css';
import '../workflows/WorkflowRunCard.css';
import './MultiModelRunCard.css';

/**
 * A multi-model run in the chat that proposed it (mock variant A′). While
 * proposed it is the plan: the user removes, restores, replaces or adds
 * models and presses Start. Then the same card shows progress step by step;
 * clicking it opens the Background work drawer on the run (a row: on that
 * row). Branch approvals are answered on their row. Read-only (a
 * Scheduled-only transcript) keeps the rows, Side by side and the answers to
 * approvals, and drops the plan and run controls.
 */

export type DrawerFocus = { threadKey: string; step: number };

const CONTEXT_WORD = { fork: 'Fork', fresh: 'Fresh' } as const;
const CONTEXT_EXPLAINED = {
  fork: "Fork: inherits this conversation's history",
  fresh: 'Fresh: only the prompt the agent wrote',
} as const;
const REVIEW_BODY = 'Each branch reads the other answers and may revise its conclusion';

const threadLabel = (thread: Pick<MultiModelThreadView, 'runtimeLabel' | 'modelLabel'>) => `${thread.runtimeLabel} · ${thread.modelLabel}`;
const threadPick = (thread: MultiModelThreadView): MultiModelModelPick => ({ runtimeId: thread.runtimeId, providerId: thread.providerId, modelId: thread.modelId });

/** The caller's permission as it would run now, global setting first (the backend resolves it again at each branch's creation). */
function LivePermissionText({ nodeId, view }: { nodeId: string; view: MultiModelRunView }) {
  const node = useChatNode(nodeId);
  const preferences = usePermissionPreferences(node ? workspaceBackendApiBase(node.projectId) : undefined);
  // Until a remote backend's settings arrive, the mode it resolved for the plan.
  if (!node || preferences.loading) return <>{permissionText(view)}</>;
  const { mode, approveForMe } = chatPermissionChoiceParts(effectiveChatPermissionChoice(preferences, node));
  return <>{permissionText({ permissionMode: mode, approveForMe: approveForMe || undefined })}</>;
}

function GlyphStack({ threads }: { threads: readonly MultiModelThreadView[] }) {
  return (
    <span className="gstack">
      {threads.map((thread) => <ModelGlyph key={thread.key} runtimeId={thread.runtimeId} label={thread.runtimeLabel} />)}
    </span>
  );
}

function Who({ thread }: { thread: MultiModelThreadView }) {
  return <span className="who"><b>{thread.runtimeLabel}</b> · {thread.modelLabel}</span>;
}

/** Which picker is open: under a row (replace) or under "+ Add model". */
type PickerTarget = { key: string } | 'add' | null;

// ─── plan ───────────────────────────────────────────────────────────────

function PlanRow({ thread, controls, pending, pickerOpen, picker, onTogglePicker, onEdit }: {
  thread: MultiModelThreadView;
  controls: boolean;
  pending: boolean;
  pickerOpen: boolean;
  picker: React.ReactNode;
  onTogglePicker: () => void;
  onEdit: (edit: MultiModelPlanEdit) => void;
}) {
  const [explain, setExplain] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const label = threadLabel(thread);
  if (thread.removed) {
    return (
      <div className="prow2 removed" data-testid="mm-plan-row" data-key={thread.key}>
        <div className="r1">
          <ModelGlyph runtimeId={thread.runtimeId} label={thread.runtimeLabel} />
          <Who thread={thread} />
          {controls && (
            <button type="button" className="linkbtn" disabled={pending} aria-label={`Undo removing ${label}`} onClick={() => onEdit({ op: 'restore', key: thread.key })}>Undo</button>
          )}
        </div>
      </div>
    );
  }
  const togglePrompt = () => setPromptOpen((open) => !open);
  return (
    <div className="prow2" data-testid="mm-plan-row" data-key={thread.key}>
      <div className="r1">
        <ModelGlyph runtimeId={thread.runtimeId} label={thread.runtimeLabel} />
        <Who thread={thread} />
        <button type="button" className="ctxq" title={CONTEXT_EXPLAINED[thread.context]} aria-expanded={explain} onClick={() => setExplain((open) => !open)}>
          {CONTEXT_WORD[thread.context]}
        </button>
        {controls && (
          <span className="acts2">
            <button type="button" className="ibtn" title="Replace model" aria-label={`Replace ${label}`} aria-expanded={pickerOpen} data-picker-toggle disabled={pending} onClick={onTogglePicker}>⇄</button>
            <button type="button" className="ibtn" title="Remove" aria-label={`Remove ${label}`} disabled={pending} onClick={() => onEdit({ op: 'remove', key: thread.key })}>×</button>
          </span>
        )}
      </div>
      {explain && <p className="ctxx">{CONTEXT_EXPLAINED[thread.context]}</p>}
      {thread.promptPreview && (
        <div
          className={promptOpen ? 'pp2 open' : 'pp2'}
          role="button"
          tabIndex={0}
          aria-expanded={promptOpen}
          title={promptOpen ? 'Click to collapse' : 'Click to show all'}
          onClick={togglePrompt}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); togglePrompt(); } }}
        >
          {thread.promptPreview}
        </div>
      )}
      {pickerOpen && picker}
    </div>
  );
}

function PlanCard({ run, view, identity, pending, error, controls }: {
  run: WorkflowRunDtoV1;
  view: MultiModelRunView;
  identity: AgentResourceIdentity;
  pending?: WorkflowPendingKind;
  error?: string;
  controls: MultiModelCommands | null;
}) {
  const chat = useOptionalChatActions();
  const ready = useReadyModels(identity.backendConnectionId, run.workspaceId);
  const [picker, setPicker] = useState<PickerTarget>(null);
  const closePicker = useCallback(() => setPicker(null), []);
  const live = liveThreads(view);
  const busy = !!pending;
  const addDisabled = busy || live.length >= MULTI_MODEL_LIMITS.threads || view.threads.length >= MULTI_MODEL_LIMITS.rows;
  const caller = { runtimeId: view.callerRuntimeId, label: view.callerRuntimeLabel };
  const pickerFor = (target: Exclude<PickerTarget, null>) => {
    const replacing = target === 'add' ? undefined : view.threads.find((thread) => thread.key === target.key);
    return (
      <MultiModelModelPicker
        title={replacing ? `Replace ${threadLabel(replacing)}` : 'Add a model'}
        ready={ready.state}
        onLoad={ready.load}
        current={replacing ? threadPick(replacing) : undefined}
        taken={live.filter((thread) => thread !== replacing).map(threadPick)}
        onClose={closePicker}
        onPick={(pick) => {
          setPicker(null);
          controls?.edit(replacing ? { op: 'replace', key: replacing.key, pick } : { op: 'add', pick });
        }}
      />
    );
  };
  return (
    <article className="workflow-run-card mm-card is-plan" data-testid="multi-model-card" data-phase="proposed" aria-label={`Multi-model plan ${view.title}, needs you`}>
      <div className="top">
        <span className="eb"><span className="ic"><ForkIcon /></span>Multi-model plan</span>
        <span className="run-chip" style={{ color: RUN_CHIP_COLOR.wait.color, background: RUN_CHIP_COLOR.wait.fill }}><span className="dot" />Needs you</span>
      </div>
      <h3 className="title">{view.title}</h3>
      <ol className="steps">
        <li className="step">
          <span className="n">1</span>
          <div className="sh">Answer separately<span className="sub">{live.length === 1 ? '1 branch starts' : `${live.length} branches start together`}</span></div>
          <div className="list2">
            {view.threads.map((thread) => (
              <PlanRow
                key={thread.key}
                thread={thread}
                controls={!!controls}
                pending={busy}
                pickerOpen={picker !== null && picker !== 'add' && picker.key === thread.key}
                picker={picker !== null && picker !== 'add' && picker.key === thread.key ? pickerFor(picker) : null}
                onTogglePicker={() => setPicker((open) => (open !== null && open !== 'add' && open.key === thread.key ? null : { key: thread.key }))}
                onEdit={(edit) => controls?.edit(edit)}
              />
            ))}
          </div>
          {controls && (
            <div className="addwrap">
              <button type="button" className="addlink" disabled={addDisabled} aria-expanded={picker === 'add'} data-picker-toggle onClick={() => setPicker((open) => (open === 'add' ? null : 'add'))}>
                ＋ Add model
              </button>
              {picker === 'add' && pickerFor('add')}
            </div>
          )}
        </li>
        {view.reviewRounds > 0 && (
          <li className="step">
            <span className="n">2</span>
            <div className="sh">{view.reviewRounds === 1 ? 'Review once' : 'Review twice'}<GlyphStack threads={live} /></div>
            <p className="sd">{REVIEW_BODY}</p>
          </li>
        )}
        <li className="step">
          <span className="n">{view.reviewRounds > 0 ? 3 : 2}</span>
          <div className="sh">Synthesis</div>
          <p className="sd"><ModelGlyph runtimeId={caller.runtimeId} label={caller.label} />Written by this chat ({view.callerModelLabel}) after reading every answer</p>
        </li>
      </ol>
      <div className="meta2">
        Same permissions as this chat ({chat ? <LivePermissionText nodeId={view.callerNodeId} view={view} /> : permissionText(view)}) · Asks you before leaving the plan
      </div>
      {controls && (
        <div className="btns">
          <button type="button" className="qbtn pri" disabled={live.length === 0 || busy} title={live.length === 0 ? 'Add a model first' : undefined} onClick={controls.start}>
            {pending === 'start' ? 'Starting…' : `Start ${branches(live.length)}`}
          </button>
          <button type="button" className="qbtn" disabled={busy} onClick={controls.cancel}>Cancel</button>
        </div>
      )}
      {error && <div role="alert" className="alert">{error}</div>}
    </article>
  );
}

// ─── progress ───────────────────────────────────────────────────────────

function ApprovalLine({ approval, busy, onAnswer, onOpenBranch }: {
  approval: WorkflowApprovalDto;
  busy: boolean;
  onAnswer?: MultiModelCommands['answer'];
  onOpenBranch?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = approvalText(approval);
  const long = isLongApproval(approval);
  return (
    <div className="apl" role="group" aria-label={`Approval needed: ${approval.title}`} data-card-click="ignore" data-testid="mm-approval">
      <span className="ak">{approvalKindWord(approval)}</span>
      {detail && (
        <code
          className={open ? 'open' : undefined}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          title={open ? 'Click to collapse' : 'Click to show all'}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen((value) => !value); } }}
        >
          {detail}
        </code>
      )}
      {onAnswer && (
        <span className="bb">
          {approval.options.map((option, index) => (
            <button
              key={option.optionId}
              type="button"
              className={index === 0 && !long ? 'qbtn warn' : 'qbtn'}
              disabled={busy}
              onClick={() => onAnswer(approval.id, option.optionId)}
            >
              {option.name}
            </button>
          ))}
        </span>
      )}
      {(long || onOpenBranch) && (
        <span className="note">
          {long && 'Long request: check it in the branch'}
          {long && onOpenBranch && ' · '}
          {onOpenBranch && <button type="button" className="linkbtn" onClick={onOpenBranch}>Open branch</button>}
        </span>
      )}
    </div>
  );
}

function ProgressRow({ run, view, thread, step, now, pending, controls, onAnswer, pickerOpen, picker, onTogglePicker, onOpenDrawer, onOpenBranch }: {
  run: WorkflowRunDtoV1;
  view: MultiModelRunView;
  thread: MultiModelThreadView;
  step: number;
  now: number;
  pending?: WorkflowPendingKind;
  controls: MultiModelCommands | null;
  onAnswer?: MultiModelCommands['answer'];
  pickerOpen: boolean;
  picker: React.ReactNode;
  onTogglePicker: () => void;
  onOpenDrawer?: (focus?: DrawerFocus) => void;
  onOpenBranch?: (childNodeId: string) => void;
}) {
  const state = thread.steps[step];
  const kind = step === 0 ? 'answer' : 'review';
  const icon = stepIcon(state.status);
  const label = stepLabel(kind, state.status);
  const elapsed = threadElapsed(state, now);
  const approval = state.status === 'waiting' ? approvalForRow(run, thread.key, step) : undefined;
  const openBranch = onOpenBranch && thread.childNodeId ? () => onOpenBranch(thread.childNodeId!) : undefined;
  // Retry and Replace model sit on the step Retry re-runs and the steps skipped after it (mock A′).
  const actions = fixesAtStep(thread, step) ? threadActions(view, thread, { readOnly: !controls, busy: !!pending }) : {};
  const { retry, replace } = actions;
  const open = onOpenDrawer ? () => onOpenDrawer({ threadKey: thread.key, step }) : undefined;
  let line: React.ReactNode = null;
  if (approval) {
    line = <ApprovalLine approval={approval} busy={pending === 'answer'} onAnswer={onAnswer} onOpenBranch={openBranch} />;
  } else if (state.status === 'waiting') {
    line = (
      <div className="line wait" data-card-click="ignore">
        Waiting for your answer in the branch
        {openBranch && <> · <button type="button" className="linkbtn" onClick={openBranch}>Open branch</button></>}
      </div>
    );
  } else if (MULTI_MODEL_STEP_IN_FLIGHT.has(state.status) && state.now) {
    line = <div className="line now ellip"><span className="k">❯</span> {state.now}</div>;
  } else if (state.status === 'completed' && state.summary) {
    line = <div className="line">{state.summary}</div>;
  } else if (ENDED_ROW.has(state.status) && (state.error || retry || replace)) {
    const reason = state.error && state.status === 'skipped' && kind === 'review' ? `Didn't take part: ${state.error}` : state.error;
    line = (
      <div className={state.status === 'failed' ? 'line err fixl' : 'line quiet fixl'} data-card-click="ignore">
        {reason}
        {retry && <>{reason ? ' · ' : ''}<button type="button" className="linkbtn" disabled={retry.disabled} onClick={() => controls!.retryThread(thread.key)}>Retry</button></>}
        {replace && (
          <>
            {reason || retry ? ' · ' : ''}
            <button type="button" className="linkbtn" disabled={replace.disabled} aria-expanded={pickerOpen} data-picker-toggle onClick={onTogglePicker}>Replace model</button>
          </>
        )}
      </div>
    );
  }
  const head = (
    <>
      <ModelGlyph runtimeId={thread.runtimeId} label={thread.runtimeLabel} />
      <Who thread={thread} />
      <span className={`st ${icon.tone}`}>
        {icon.icon === 'dot' ? <span className={icon.tone === 'run' ? 'dot term-dot-i--run' : 'dot'} /> : icon.icon} {label}
      </span>
      <span className="t">{elapsed === undefined ? '—' : formatDuration(elapsed)}</span>
    </>
  );
  // The head line is the row's one button (the drawer); the line under it and
  // its controls stay outside it. A click elsewhere on the row opens the drawer too.
  return (
    <div
      className={open ? 'trow r2row opens' : 'trow r2row'}
      data-testid="mm-row"
      data-key={thread.key}
      data-step={step}
      onClick={open ? (event) => {
        if (!cardClickOpens(event)) return;
        event.stopPropagation();
        open();
      } : undefined}
    >
      {open ? (
        <button
          type="button"
          className="r1"
          aria-label={`${threadLabel(thread)}, ${label}`}
          onClick={(event) => { event.stopPropagation(); open(); }}
        >
          {head}
        </button>
      ) : <div className="r1">{head}</div>}
      {line}
      {state.notice && <div className="line notice">{state.notice}</div>}
      {pickerOpen && picker}
    </div>
  );
}

const STEP_CLASS: Record<StepState, string> = { done: 'ok', running: 'run', idle: 'idle', failed: 'fail', stopped: 'stop' };
/** A failure is a red ✕; a stop is neutral, as the rows' ■. */
const STEP_MARK: Partial<Record<StepState, string>> = { done: '✓', failed: '✕', stopped: '■' };

function StepMark({ state, n }: { state: StepState; n: number }) {
  return <span className={`n ${STEP_CLASS[state]}`}>{STEP_MARK[state] ?? n}</span>;
}

function SummaryLine({ view, step }: { view: MultiModelRunView; step: number }) {
  const parts = collapsedSummary(view, step);
  return (
    <p className="sd">
      {parts.map((part, index) => (
        <React.Fragment key={index}>
          {index > 0 && ' · '}
          <span className={part.tone === 'select' ? 'c-wait' : part.tone === 'run' ? 'c-run' : part.tone === 'danger' ? 'c-fail' : undefined}>{part.text}</span>
        </React.Fragment>
      ))}
    </p>
  );
}

/** Scroll the caller's pane to one of its messages (TPane's michi:scroll-to-message, which flashes it). */
function scrollToMessage(nodeId: string, messageId: string): void {
  window.dispatchEvent(new CustomEvent('michi:scroll-to-message', { detail: { nodeId, messageId } }));
}

function ProgressCard({ run, view, identity, pending, error, controls, onAnswer, onOpenDrawer }: {
  run: WorkflowRunDtoV1;
  view: MultiModelRunView;
  identity: AgentResourceIdentity;
  pending?: WorkflowPendingKind;
  error?: string;
  controls: MultiModelCommands | null;
  onAnswer?: MultiModelCommands['answer'];
  onOpenDrawer?: (focus?: DrawerFocus) => void;
}) {
  const chat = useOptionalChatActions();
  const ready = useReadyModels(identity.backendConnectionId, run.workspaceId);
  const [picker, setPicker] = useState<{ key: string; step: number } | null>(null);
  const closePicker = useCallback(() => setPicker(null), []);
  const [stepOpen, setStepOpen] = useState<Record<number, boolean>>({});
  const now = useNow(1_000, view.phase === 'running');
  const live = liveThreads(view);
  const states = stepStates(view);
  const openByDefault = defaultOpenStep(view);
  const rounds = view.reviewRounds;
  const chip = runChip(run, view, now);
  const children = childNodeIds(view);
  const onOpenBranch = chat ? (childNodeId: string) => chat.openPanesSideBySide(view.callerNodeId, [childNodeId], { focusNodeId: childNodeId }) : undefined;
  const { stopAll, retry } = runActions(view, { readOnly: !controls, busy: !!pending });
  // Run Retry sits by what it re-runs: a failed synthesis or addendum in the synthesis step, the rest under the title.
  const retryInSynthesis = retry?.target === 'synthesis' || retry?.target === 'addendum';
  const retryInStatus = !!retry && !retryInSynthesis;
  const detail = view.phase !== 'running' ? run.statusDetail : undefined;
  const runRetryButton = retry && controls && (
    <button type="button" className={retryInStatus && (view.phase === 'failed' || view.phase === 'interrupted') ? 'qbtn' : 'linkbtn'} disabled={retry.disabled} onClick={controls.retryRun}>
      {retry.target === 'rows' && view.phase === 'completed' ? 'Retry failed' : 'Retry'}
    </button>
  );
  const caller = <ModelGlyph runtimeId={view.callerRuntimeId} label={view.callerRuntimeLabel} />;

  const pickerFor = (thread: MultiModelThreadView) => (
    <MultiModelModelPicker
      title={`Replace ${threadLabel(thread)}`}
      ready={ready.state}
      onLoad={ready.load}
      current={threadPick(thread)}
      taken={live.filter((other) => other !== thread).map(threadPick)}
      onClose={closePicker}
      onPick={(pick) => { setPicker(null); controls?.replaceThread(thread.key, pick); }}
    />
  );

  const answerStep = (step: number) => {
    const rows = live.filter((thread) => thread.steps[step]);
    const progress = stepProgress(view, step);
    const title = step === 0 ? 'Answer separately' : rounds === 1 ? 'Review once' : 'Review';
    const round = rounds === 2 && step > 0 ? `round ${step} of 2` : null;
    if (!progress.started) {
      return (
        <li key={step} className={`step ${STEP_CLASS[states[step]]}`}>
          <StepMark state={states[step]} n={step + 1} />
          <div className="sh">{title}{round && <span className="sub">{round}</span>}<GlyphStack threads={live} /></div>
          <p className="sd">{REVIEW_BODY}</p>
        </li>
      );
    }
    const sub = `${round ? `${round} · ` : ''}${progress.label}`;
    const isOpen = stepOpen[step] ?? step === openByDefault;
    return (
      <li key={step} className={`step ${STEP_CLASS[states[step]]}`}>
        <StepMark state={states[step]} n={step + 1} />
        <button type="button" className="sh tog" aria-expanded={isOpen} onClick={() => setStepOpen((open) => ({ ...open, [step]: !isOpen }))}>
          {title}<span className="sub">{sub}</span><span className="chev" aria-hidden>{isOpen ? '⌃' : '⌄'}</span>
        </button>
        {isOpen ? (
          <div className="list2">
            {rows.map((thread) => (
              <ProgressRow
                key={thread.key}
                run={run}
                view={view}
                thread={thread}
                step={step}
                now={now}
                pending={pending}
                controls={controls}
                onAnswer={onAnswer}
                pickerOpen={picker?.key === thread.key && picker.step === step}
                picker={picker?.key === thread.key && picker.step === step ? pickerFor(thread) : null}
                onTogglePicker={() => setPicker((open) => (open?.key === thread.key && open.step === step ? null : { key: thread.key, step }))}
                onOpenDrawer={onOpenDrawer}
                onOpenBranch={onOpenBranch}
              />
            ))}
          </div>
        ) : <SummaryLine view={view} step={step} />}
      </li>
    );
  };

  const synthesis = view.synthesis.status;
  const synthesisStep = rounds + 1;
  const note = synthesisNote(view);
  const addendum = addendumOutcome(view);
  // Once an addendum exists, the latest reply the run wrote is where to read it.
  const writtenId = view.synthesis.addenda ? view.lastMessageId ?? view.synthesis.messageId : view.synthesis.messageId;
  let synthesisBody: React.ReactNode;
  if (synthesis === 'completed') {
    synthesisBody = (
      <>
        <p className="sd">
          <span className="c-ok">✓</span>{' '}
          {writtenId
            ? <button type="button" className="linkbtn" onClick={() => scrollToMessage(view.callerNodeId, writtenId)}>Written below ↓</button>
            : 'Written below'}
        </p>
        {addendum && (
          <p className="sd" data-card-click="ignore" data-testid="mm-addendum">
            <span className={addendum.tone === 'ok' ? 'c-ok' : addendum.tone === 'fail' ? 'c-fail' : undefined}>{addendum.text}</span>
            {retry?.target === 'addendum' && <> · {runRetryButton}</>}
          </p>
        )}
      </>
    );
  } else if (synthesis === 'queued' || synthesis === 'running') {
    synthesisBody = <p className="sd">{caller}Writing the synthesis…</p>;
  } else if (note) {
    synthesisBody = (
      <p className="sd" data-card-click="ignore">
        <span className={note.tone === 'fail' ? 'c-fail' : undefined}>{note.text}</span>
        {retry?.target === 'synthesis' && <> · {runRetryButton}</>}
      </p>
    );
  } else {
    synthesisBody = <p className="sd">{caller}Written by this chat ({view.callerModelLabel}) after reading every answer</p>;
  }
  return (
    <>
      {view.startedAt !== undefined && (
        <div className="mm-sysline" data-testid="mm-started">
          <span className="ic"><ForkIcon /></span>Started the plan · {branches(live.length)} · {formatMessageTime(view.startedAt)}
        </div>
      )}
      <article
        className={onOpenDrawer ? 'workflow-run-card workflow-run-card--opens mm-card' : 'workflow-run-card mm-card'}
        data-testid="multi-model-card"
        data-phase={view.phase}
        // A tap here opens the drawer; it does not reveal the message's actions (MessageBlock's TAP_CONTROL).
        data-tap-target={onOpenDrawer ? 'true' : undefined}
        aria-label={`Multi-model ${view.title}, ${chip.label.toLowerCase()}`}
        onClick={onOpenDrawer ? (event) => { if (cardClickOpens(event)) onOpenDrawer(); } : undefined}
      >
        <div className="top">
          <span className="eb"><span className="ic"><ForkIcon /></span>Multi-model</span>
          <span className="run-chip" data-testid="mm-chip" style={{ color: RUN_CHIP_COLOR[chip.tone].color, background: RUN_CHIP_COLOR[chip.tone].fill }}>
            {chip.tone === 'run' && <span className="dot term-dot-i--run" />}
            {chip.label}
            {chip.time && <span className="run-chip__time">{chip.time}</span>}
          </span>
        </div>
        <h3 className="title">{view.title}</h3>
        {detail || retryInStatus ? (
          <div className="status" data-card-click="ignore">
            {detail && <span>{detail}</span>}
            {retryInStatus && runRetryButton}
          </div>
        ) : null}
        <ol className="steps">
          {Array.from({ length: 1 + rounds }, (_, step) => answerStep(step))}
          <li className={`step ${STEP_CLASS[states[synthesisStep]]}`}>
            <StepMark state={states[synthesisStep]} n={synthesisStep + 1} />
            <div className="sh">Synthesis</div>
            {synthesisBody}
          </li>
        </ol>
        {error && <div role="alert" className="alert">{error}</div>}
        <div className="foot2">
          <span>Same permissions as this chat ({permissionText(view)}) · {branches(live.length)}</span>
          {(stopAll || (chat && children.length > 0)) && (
            <span className="fa">
              {stopAll && controls && (
                <button type="button" className="linkbtn" disabled={stopAll.disabled} onClick={controls.stop}>
                  {pending === 'stop' ? 'Stop all…' : 'Stop all'}
                </button>
              )}
              {chat && children.length > 0 && (
                <button type="button" className="linkbtn" onClick={() => chat.openPanesSideBySide(view.callerNodeId, children)}>
                  <ColumnsIcon /> Side by side
                </button>
              )}
            </span>
          )}
        </div>
      </article>
    </>
  );
}

/** A proposal that was cancelled or replaced before Start: one line. */
function CancelledPlanCard({ run, view }: { run: WorkflowRunDtoV1; view: MultiModelRunView }) {
  const replaced = run.statusDetail === 'Replaced by a newer plan';
  return (
    <article className="workflow-run-card mm-card is-compact" data-testid="multi-model-card" data-phase="cancelled" aria-label={`Multi-model plan ${view.title}, ${replaced ? 'replaced' : 'cancelled'}`}>
      <span className="eb"><span className="ic"><ForkIcon /></span>Multi-model plan</span>
      <h3 className="title">{view.title}</h3>
      <span className="gone">{replaced ? 'Replaced by a newer plan' : 'Plan cancelled'}</span>
    </article>
  );
}

export function MultiModelRunCard({ run, identity, pending, error, readOnly, onOpenDrawer }: {
  run: WorkflowRunDtoV1;
  identity: AgentResourceIdentity;
  pending?: WorkflowPendingKind;
  error?: string;
  /** A Scheduled-only transcript: no plan or run controls; its approvals can still be answered. */
  readOnly?: boolean;
  /** Open the Background work drawer on the run, or on one row's step. */
  onOpenDrawer?: (focus?: DrawerFocus) => void;
}) {
  const commands = useMultiModelCommands(identity);
  const view = run.multiModel;
  if (!view) return null;
  const controls = readOnly ? null : commands;
  if (view.phase === 'proposed') {
    return <PlanCard run={run} view={view} identity={identity} pending={pending} error={error} controls={controls} />;
  }
  if (view.phase === 'cancelled' && view.startedAt === undefined) return <CancelledPlanCard run={run} view={view} />;
  return <ProgressCard run={run} view={view} identity={identity} pending={pending} error={error} controls={controls} onAnswer={commands?.answer} onOpenDrawer={onOpenDrawer} />;
}
