import { describe, expect, it } from 'vitest';
import type { MultiModelRunView, MultiModelStepStatus, MultiModelThreadView } from 'michi-shared';
import {
  addendumOutcome,
  approvalForRow,
  approvalKindWord,
  approvalText,
  childNodeIds,
  collapsedSummary,
  defaultOpenStep,
  fixesAtStep,
  formatDuration,
  isLongApproval,
  isThreadReplaceable,
  isThreadRetryable,
  isThreadStoppable,
  lateWork,
  liveThreads,
  permissionText,
  runActions,
  runChip,
  runtimeGlyph,
  stepIcon,
  stepLabel,
  stepProgress,
  stepStates,
  synthesisNote,
  threadActions,
  threadElapsed,
  type ActionOptions,
} from './multiModelPresentation';

function thread(key: string, runtimeLabel: string, statuses: MultiModelStepStatus[], patch: Partial<MultiModelThreadView> = {}): MultiModelThreadView {
  return {
    key, runtimeId: runtimeLabel.toLowerCase(), providerId: null, modelId: null, reasoning: null, runtimeLabel, modelLabel: 'Default model',
    context: 'fresh', promptPreview: 'Compare.', childNodeId: `n-${key}`,
    steps: statuses.map((status, round) => ({ kind: round === 0 ? 'answer' : 'review', round, status })),
    ...patch,
  };
}

function view(phase: MultiModelRunView['phase'], threads: MultiModelThreadView[], patch: Partial<MultiModelRunView> = {}): MultiModelRunView {
  return {
    version: 1, phase, title: 'Caches', askPreview: '', callerNodeId: 'n-caller', callerMessageId: null, callerRuntimeId: 'claude',
    callerRuntimeLabel: 'Claude Code', callerModelLabel: 'Opus', permissionMode: 'ask', reviewRounds: 1, threads,
    synthesis: { status: 'pending' }, ...patch,
  };
}

describe('multi-model presentation', () => {
  it('labels rows per step kind and status', () => {
    expect(['queued', 'running', 'waiting', 'completed', 'failed', 'stopped', 'skipped', 'cancelled', 'interrupted', 'pending']
      .map((status) => stepLabel('answer', status as MultiModelStepStatus)))
      .toEqual(['Queued', 'Answering', 'Needs you', 'Answered', 'Failed', 'Stopped', 'Skipped', 'Cancelled', 'Interrupted', 'Waiting']);
    expect(['running', 'completed', 'skipped', 'waiting'].map((status) => stepLabel('review', status as MultiModelStepStatus)))
      .toEqual(['Reviewing', 'Revised', 'Skipped', 'Needs you']);
    expect(stepIcon('completed')).toEqual({ icon: '✓', tone: 'ok' });
    expect(stepIcon('failed')).toEqual({ icon: '✕', tone: 'fail' });
    expect(stepIcon('stopped').tone).toBe('stop');
    expect(stepIcon('waiting')).toEqual({ icon: 'dot', tone: 'wait' });
  });

  it('formats durations and a row\'s elapsed time', () => {
    expect([0, 48_400, 72_000, 3_600_000 + 5 * 60_000].map(formatDuration)).toEqual(['0s', '48s', '1m 12s', '1h 5m']);
    expect(threadElapsed({ startedAt: 1_000 }, 49_000)).toBe(48_000);
    expect(threadElapsed({ startedAt: 1_000, endedAt: 2_000 }, 49_000)).toBe(1_000);
    expect(threadElapsed(undefined, 1)).toBeUndefined();
  });

  it('times a finished run without an end stamp to its last update, not to now', () => {
    const run = { startedAt: 1_000, endedAt: undefined, updatedAt: 73_000 };
    expect(runChip(run, view('completed', []), 999_999)).toEqual({ label: 'Done', tone: 'ok', time: '1m 12s' });
    expect(runChip(run, view('running', [], { startedAt: 13_000 }), 73_000)).toEqual({ label: 'Running', tone: 'run', time: '1m' });
    expect(runChip(run, view('proposed', []), 0)).toEqual({ label: 'Needs you', tone: 'wait' });
  });

  it('says the permission mode and picks a glyph per runtime', () => {
    expect(permissionText({ permissionMode: 'ask' })).toBe('Ask');
    expect(permissionText({ permissionMode: 'ask', approveForMe: true })).toBe('Ask · Approve for me');
    expect(permissionText({ permissionMode: 'trust' })).toBe('Trust');
    expect(permissionText({ permissionMode: 'yolo' })).toBe('YOLO');
    expect(runtimeGlyph('pi', 'Pi')).toEqual({ letter: 'π', color: 'var(--term-digest)' });
    expect(runtimeGlyph('gemini', 'gemini CLI')).toEqual({ letter: 'G', color: 'var(--term-mid)' });
  });

  it('lists live rows and their branch nodes', () => {
    const v = view('running', [thread('t1', 'Codex', ['running']), thread('t2', 'Pi', [], { removed: true }), thread('a1', 'Kiro', ['queued'], { childNodeId: null })]);
    expect(liveThreads(v).map((t) => t.key)).toEqual(['t1', 'a1']);
    expect(childNodeIds(v)).toEqual(['n-t1']);
  });

  it('draws the step circles', () => {
    expect(stepStates(view('proposed', [thread('t1', 'Codex', [])]))).toEqual(['idle', 'idle', 'idle']);
    expect(stepStates(view('running', [thread('t1', 'Codex', ['completed', 'running']), thread('t2', 'Pi', ['failed', 'skipped'])])))
      .toEqual(['done', 'running', 'idle']);
    expect(stepStates(view('completed', [thread('t1', 'Codex', ['completed', 'completed'])], { synthesis: { status: 'completed' } })))
      .toEqual(['done', 'done', 'done']);
    expect(stepStates(view('cancelled', [thread('t1', 'Codex', ['cancelled', 'pending'])], { synthesis: { status: 'cancelled' } })))
      .toEqual(['stopped', 'idle', 'stopped']);
    expect(stepStates(view('running', [thread('t1', 'Codex', ['queued'])], { reviewRounds: 0 }))).toEqual(['running', 'idle']);
    // A failure is not a stop: the circles tell them apart.
    expect(stepStates(view('failed', [thread('t1', 'Codex', ['failed']), thread('t2', 'Pi', ['stopped'])], { reviewRounds: 0 }))).toEqual(['failed', 'idle']);
    expect(stepStates(view('failed', [thread('t1', 'Codex', ['completed'])], { reviewRounds: 0, synthesis: { status: 'failed' } }))).toEqual(['done', 'failed']);
    expect(stepStates(view('interrupted', [thread('t1', 'Codex', ['completed'])], { reviewRounds: 0, synthesis: { status: 'interrupted' } }))).toEqual(['done', 'stopped']);
  });

  it('opens the current step while running and the last answered step once finished', () => {
    expect(defaultOpenStep(view('running', [thread('t1', 'Codex', ['completed', 'running']), thread('t2', 'Pi', ['completed', 'completed'])]))).toBe(1);
    expect(defaultOpenStep(view('running', [thread('t1', 'Codex', ['completed', 'completed'])], { synthesis: { status: 'running' } }))).toBe(2);
    expect(defaultOpenStep(view('completed', [thread('t1', 'Codex', ['completed', 'completed'])], { synthesis: { status: 'completed' } }))).toBe(1);
    expect(defaultOpenStep(view('completed', [thread('t1', 'Codex', ['completed', 'skipped']), thread('t2', 'Pi', ['failed', 'skipped'])])))
      .toBe(0);
    expect(defaultOpenStep(view('proposed', [thread('t1', 'Codex', [])]))).toBe(0);
    // An interrupted run opens the step its Retry continues, not the last answered one.
    expect(defaultOpenStep(view('interrupted', [thread('t1', 'Codex', ['completed', 'interrupted']), thread('t2', 'Pi', ['completed', 'interrupted'])]))).toBe(1);
    expect(defaultOpenStep(view('interrupted', [thread('t1', 'Codex', ['interrupted', 'pending']), thread('t2', 'Pi', ['completed', 'pending'])]))).toBe(0);
  });

  it('summarizes a collapsed step', () => {
    const live = view('running', [
      thread('t1', 'Codex', ['waiting']), thread('t2', 'Kiro', ['running']), thread('t3', 'Pi', ['completed']), thread('t4', 'Crew', ['failed']),
    ]);
    expect(collapsedSummary(live, 0)).toEqual([
      { text: 'Codex waits for your approval', tone: 'select' }, { text: 'Kiro answering', tone: 'run' },
      { text: 'Pi answered' }, { text: 'Crew failed', tone: 'danger' },
    ]);
    const ended = view('running', [thread('t1', 'Codex', ['completed', 'running']), thread('t2', 'Kiro', ['failed', 'skipped']), thread('t3', 'Pi', ['completed', 'completed'])]);
    expect(collapsedSummary(ended, 0).map((part) => part.text).join(' · ')).toBe('3 branches · 2 answered · Kiro failed');
    expect(collapsedSummary(ended, 1)).toEqual([{ text: 'Codex reviewing', tone: 'run' }, { text: 'Pi revised' }]);
    const reviewed = view('completed', [thread('t1', 'Codex', ['completed', 'completed']), thread('t2', 'Pi', ['completed', 'completed'])]);
    expect(collapsedSummary(reviewed, 1).map((part) => part.text).join(' · ')).toBe('2 branches read each other\'s answers and revised their conclusions');
    const alone = view('completed', [thread('t1', 'Codex', ['completed', 'skipped']), thread('t2', 'Pi', ['failed', 'skipped'])]);
    expect(collapsedSummary(alone, 1).map((part) => part.text).join(' · ')).toBe('Skipped · only one answer');
    const none = view('failed', [thread('t1', 'Codex', ['failed', 'skipped']), thread('t2', 'Pi', ['failed', 'skipped'])]);
    expect(collapsedSummary(none, 1).map((part) => part.text).join(' · ')).toBe('Skipped · no answers');
    // A restart during the review: nobody revised, so the line must not say they did.
    const cutOff = view('interrupted', [thread('t1', 'Codex', ['completed', 'interrupted']), thread('t2', 'Pi', ['completed', 'interrupted'])]);
    expect(collapsedSummary(cutOff, 1).map((part) => part.text).join(' · ')).toBe('2 branches · 0 revised · 2 interrupted');
    const mixed = view('completed', [thread('t1', 'Codex', ['completed', 'completed']), thread('t2', 'Pi', ['completed', 'stopped']), thread('t3', 'Kiro', ['completed', 'failed'])]);
    expect(collapsedSummary(mixed, 1).map((part) => part.text).join(' · ')).toBe('3 branches · 1 revised · 1 stopped · Kiro failed');
    const answerCut = view('interrupted', [thread('t1', 'Codex', ['interrupted']), thread('t2', 'Pi', ['completed'])]);
    expect(collapsedSummary(answerCut, 0).map((part) => part.text).join(' · ')).toBe('2 branches · 1 answered · 1 interrupted');
  });

  it('attaches an approval to exactly one row and names its kind', () => {
    const approval = { id: 'a', nodeId: 't1@1', title: 'Approve Bash?', options: [], requestedAt: 1 };
    const run = { approvals: [approval] };
    expect(approvalForRow(run, 't1', 1)).toBe(approval);
    expect(approvalForRow(run, 't1', 0)).toBeUndefined();
    expect(approvalForRow(run, 't2', 1)).toBeUndefined();
    expect(approvalForRow({}, 't1', 1)).toBeUndefined();
    expect(['Approve Bash?', 'execute_bash', 'Running rg -n x', 'Approve apply_patch?', 'fs_write', 'Approve web_fetch?']
      .map((title) => approvalKindWord({ title }))).toEqual(['Run', 'Run', 'Run', 'Edit', 'Edit', 'Allow']);
    // Kiro's shell titles are the command itself; Pi's start with "Run: ".
    expect(['wc -l README.md', 'ls', './scripts/check.sh --fast', 'Run: wc -l README.md', '@michi/set_branch_overview', 'Reading README.md', 'web_fetch']
      .map((title) => approvalKindWord({ title }))).toEqual(['Run', 'Run', 'Run', 'Run', 'Allow', 'Allow', 'Allow']);
  });

  it("shows an approval's detail, else its title without Pi's \"Run: \"", () => {
    expect(approvalText({ title: 'Approve bash?', detail: 'Command: /bin/zsh -lc "wc -l README.md"' })).toBe('Command: /bin/zsh -lc "wc -l README.md"');
    expect(approvalText({ title: 'Run: wc -l README.md' })).toBe('wc -l README.md');
    expect(approvalText({ title: 'wc -l README.md', detail: '' })).toBe('wc -l README.md');
    expect(approvalText({ title: '@michi/set_branch_overview' })).toBe('@michi/set_branch_overview');
  });

  describe('the action model', () => {
    const rowActions = (statuses: MultiModelStepStatus[], patch: Partial<MultiModelRunView> = {}, options: ActionOptions = {}) => {
      const row = thread('t1', 'Codex', statuses);
      return threadActions(view('running', [row], patch), row, options);
    };
    const enabled = { disabled: false };

    it('row Stop: a step is queued, running or waiting', () => {
      for (const status of ['queued', 'running', 'waiting'] as const) {
        expect(rowActions([status, 'pending']), status).toEqual({ stop: enabled });
      }
      expect(rowActions(['completed', 'waiting'])).toEqual({ stop: enabled });
      expect(rowActions(['completed', 'pending'])).toEqual({});
    });

    it('row Retry and Replace model: nothing in flight and the last run step ended without an answer', () => {
      for (const status of ['failed', 'stopped', 'cancelled', 'interrupted'] as const) {
        expect(rowActions(['completed', status]), status).toEqual({ retry: enabled, replace: enabled });
      }
      expect(rowActions(['failed', 'pending']), 'the last step that ran').toEqual({ retry: enabled, replace: enabled });
      expect(rowActions(['failed', 'skipped', 'skipped']), 'skipped reviews after a failed answer').toEqual({ retry: enabled, replace: enabled });
      // The only answer, its review skipped: it answered, so there is nothing to replace.
      expect(rowActions(['completed', 'skipped'])).toEqual({});
      expect(rowActions(['completed', 'completed'])).toEqual({});
      expect(rowActions([])).toEqual({});
      const removed = thread('t1', 'Codex', ['failed'], { removed: true });
      expect(threadActions(view('running', [removed]), removed)).toEqual({});
      // A deleted branch's review cannot run again: only Replace model applies (its answer re-runs on a new branch).
      const gone = thread('t1', 'Codex', ['completed', 'stopped'], { branchGone: true });
      expect(threadActions(view('running', [gone]), gone)).toEqual({ replace: enabled });
    });

    it('Retry and Replace model wait while a stopped run settles; a command in flight holds all; read-only has none', () => {
      expect(rowActions(['running'], { settling: true })).toEqual({ stop: enabled });
      // A running run is always settling (its turns are open) and takes a row's Retry.
      expect(rowActions(['failed'], { settling: true })).toEqual({ retry: enabled, replace: enabled });
      const stoppedRow = thread('t1', 'Codex', ['failed']);
      expect(threadActions(view('cancelled', [stoppedRow], { settling: true }), stoppedRow)).toEqual({ retry: { disabled: true }, replace: { disabled: true } });
      expect(rowActions(['running'], {}, { busy: true })).toEqual({ stop: { disabled: true } });
      expect(rowActions(['failed'], {}, { readOnly: true })).toEqual({});
      const runningView = view('running', [thread('t1', 'Codex', ['running'])], { startedAt: 1, settling: true });
      expect(runActions(runningView)).toEqual({ stopAll: enabled });
      expect(runActions(runningView, { readOnly: true })).toEqual({});
      expect(runActions(view('failed', [thread('t1', 'Codex', ['failed'])], { startedAt: 1, settling: true }))).toEqual({ retry: { disabled: true, target: 'rows' } });
    });

    it('run Retry: a failed, stopped or interrupted run, or a finished one with failed rows or a failed addendum', () => {
      const started = { startedAt: 1 };
      const retryOf = (phase: MultiModelRunView['phase'], threads: MultiModelThreadView[], patch: Partial<MultiModelRunView> = {}) =>
        runActions(view(phase, threads, { ...started, ...patch })).retry?.target;
      expect(retryOf('running', [thread('t1', 'Codex', ['failed'])])).toBeUndefined();
      expect(retryOf('failed', [thread('t1', 'Codex', ['completed'])], { synthesis: { status: 'failed' } })).toBe('synthesis');
      expect(retryOf('failed', [thread('t1', 'Codex', ['failed'])])).toBe('rows');
      expect(retryOf('cancelled', [thread('t1', 'Codex', ['cancelled'])])).toBe('run');
      expect(retryOf('interrupted', [thread('t1', 'Codex', ['interrupted'])])).toBe('run');
      // A cancelled proposal was never started.
      expect(retryOf('cancelled', [thread('t1', 'Codex', [])], { startedAt: undefined })).toBeUndefined();
      const done = { synthesis: { status: 'completed' as const } };
      expect(retryOf('completed', [thread('t1', 'Codex', ['completed'])], done)).toBeUndefined();
      for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
        expect(retryOf('completed', [thread('t1', 'Codex', ['completed']), thread('t2', 'Pi', [status, 'skipped'])], done), status).toBe('rows');
      }
      // A branch the user stopped stays stopped.
      expect(retryOf('completed', [thread('t1', 'Codex', ['completed']), thread('t2', 'Pi', ['stopped'])], done)).toBeUndefined();
      expect(retryOf('completed', [thread('t2', 'Pi', ['failed'], { removed: true })], done)).toBeUndefined();
      for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
        expect(retryOf('completed', [thread('t1', 'Codex', ['completed'])], { synthesis: { status: 'completed', addenda: 1, lastAddendumStatus: status } }), status).toBe('addendum');
      }
      expect(retryOf('completed', [thread('t1', 'Codex', ['completed'])], { synthesis: { status: 'completed', addenda: 1, lastAddendumStatus: 'completed' } })).toBeUndefined();
      expect(runActions(view('completed', [], done)).stopAll).toBeUndefined();
    });

    it('puts a row\'s fixes on its last run step and the steps skipped after it', () => {
      const failedAnswer = thread('t1', 'Codex', ['failed', 'skipped']);
      expect([0, 1].map((step) => fixesAtStep(failedAnswer, step))).toEqual([true, true]);
      const failedReview = thread('t1', 'Codex', ['completed', 'failed']);
      expect([0, 1].map((step) => fixesAtStep(failedReview, step))).toEqual([false, true]);
      expect(fixesAtStep(thread('t1', 'Codex', ['pending']), 0)).toBe(false);
    });
  });

  it("counts a review's rows that took part (not skipped, started) the same way in its header and its summary", () => {
    // C answered and its branch was deleted while A and B still answered: C's review stopped before the round began.
    const deleted = view('running', [
      thread('t1', 'Codex', ['completed', 'pending']), thread('t2', 'Kiro', ['running', 'pending']), thread('t3', 'Pi', ['completed', 'stopped']),
    ]);
    expect(stepProgress(deleted, 1)).toEqual({ started: true, label: '0/1 done' });
    expect(collapsedSummary(deleted, 1).map((part) => part.text)).toEqual(['1 branch', '0 revised', '1 stopped']);
    expect(stepProgress(deleted, 0)).toEqual({ started: true, label: '2/3 done' });
    const skipped = view('completed', [thread('t1', 'Codex', ['completed', 'skipped']), thread('t2', 'Kiro', ['failed', 'skipped'])]);
    expect(stepProgress(skipped, 1)).toEqual({ started: true, label: 'Skipped' });
    expect(stepProgress(view('running', [thread('t1', 'Codex', ['running', 'pending'])]), 1).started).toBe(false);
  });

  it('checks a request in the branch when its text, detail or else title, is multi-line or clamped', () => {
    expect(isLongApproval({ title: 'Approve Bash?', detail: 'rg -n x' })).toBe(false);
    expect(isLongApproval({ title: 'Approve Bash?', detail: 'a\nb' })).toBe(true);
    expect(isLongApproval({ title: 'Approve Bash?', detail: 'x'.repeat(3999) })).toBe(true);
    expect(isLongApproval({ title: 'cat <<EOF > notes.md\nhello\nEOF' }), "Kiro's title-only command").toBe(true);
  });

  it('says which rows can be stopped or retried', () => {
    expect(isThreadStoppable(thread('t1', 'Codex', ['queued']))).toBe(true);
    expect(isThreadStoppable(thread('t1', 'Codex', ['completed', 'waiting']))).toBe(true);
    expect(isThreadStoppable(thread('t1', 'Codex', ['completed', 'pending']))).toBe(false);
    for (const status of ['failed', 'stopped', 'cancelled', 'interrupted'] as const) {
      expect(isThreadRetryable(thread('t1', 'Codex', ['completed', status])), status).toBe(true);
    }
    expect(isThreadRetryable(thread('t1', 'Codex', ['failed', 'pending'])), 'the latest started step').toBe(true);
    expect(isThreadRetryable(thread('t1', 'Codex', ['completed', 'skipped']))).toBe(false);
    expect(isThreadRetryable(thread('t1', 'Codex', ['failed', 'skipped'])), 'skipped reviews after a failed answer').toBe(true);
    expect(isThreadRetryable(thread('t1', 'Codex', ['failed', 'skipped', 'skipped']))).toBe(true);
    expect(isThreadRetryable(thread('t1', 'Codex', ['running']))).toBe(false);
    expect(isThreadRetryable(thread('t1', 'Codex', []))).toBe(false);
    // A deleted branch cannot review again; its answer step re-runs on a new branch.
    expect(isThreadRetryable(thread('t1', 'Codex', ['completed', 'stopped'], { branchGone: true }))).toBe(false);
    expect(isThreadReplaceable(thread('t1', 'Codex', ['completed', 'stopped'], { branchGone: true }))).toBe(true);
    expect(isThreadRetryable(thread('t1', 'Codex', ['failed', 'skipped'], { branchGone: true }))).toBe(true);
    // Replace model follows Retry: an answer whose review was skipped keeps it.
    expect(isThreadReplaceable(thread('t1', 'Codex', ['completed', 'skipped']))).toBe(false);
    expect(isThreadReplaceable(thread('t1', 'Codex', ['failed', 'skipped']))).toBe(true);
  });

  describe('late work', () => {
    const done = (threads: MultiModelThreadView[], synthesis: Partial<MultiModelRunView['synthesis']> = {}, phase: MultiModelRunView['phase'] = 'running') =>
      view(phase, threads, { startedAt: 1_000, synthesis: { status: 'completed', messageId: 'syn', startedAt: 50_000, endedAt: 60_000, ...synthesis } });
    const lateRow = (key: string, status: MultiModelStepStatus, startedAt: number) =>
      thread(key, 'Pi', [status], { late: true, steps: [{ kind: 'answer', round: 0, status, startedAt }] });

    it('is late work while a written run runs again, timed from the late step', () => {
      const run = { startedAt: 1_000, updatedAt: 2_000 };
      expect(lateWork(view('running', [thread('t1', 'Codex', ['running'])]))).toBeNull();
      const answering = done([thread('t1', 'Codex', ['completed']), lateRow('t2', 'running', 100_000), lateRow('t3', 'queued', 104_000)]);
      expect(lateWork(answering)).toEqual({ answering: 2, since: 100_000 });
      expect(runChip(run, answering, 112_000)).toEqual({ label: 'Adding 2 late answers', tone: 'run', time: '12s' });
      const adding = done([thread('t1', 'Codex', ['completed']), lateRow('t2', 'completed', 100_000)], { addenda: 1, lastAddendumStatus: 'running' });
      expect(runChip(run, adding, 130_000)).toEqual({ label: 'Adding to the synthesis', tone: 'run', time: '30s' });
      // Not late work: the chip counts from Start.
      expect(runChip(run, view('running', [thread('t1', 'Codex', ['running'])], { startedAt: 1_000 }), 61_000)).toEqual({ label: 'Running', tone: 'run', time: '1m' });
      // Done counts to the synthesis, not to a later addendum.
      expect(runChip({ ...run, endedAt: 900_000 }, done([thread('t1', 'Codex', ['completed'])], {}, 'completed'), 0).time).toBe('59s');
    });

    it('says how the addendum went once the late work is over', () => {
      expect(addendumOutcome(done([lateRow('t2', 'completed', 100_000)], { addenda: 1, lastAddendumStatus: 'running' }))).toBeNull();
      expect(addendumOutcome(done([lateRow('t2', 'completed', 100_000)], { addenda: 1, lastAddendumStatus: 'completed' }, 'completed')))
        .toEqual({ text: 'Added 1 late answer to the synthesis', tone: 'ok' });
      expect(addendumOutcome(done([lateRow('t2', 'completed', 1), lateRow('t3', 'completed', 2)], { addenda: 1, lastAddendumStatus: 'failed' }, 'completed')))
        .toEqual({ text: "Couldn't add 2 late answers", tone: 'fail' });
      expect(addendumOutcome(done([lateRow('t2', 'completed', 1)], { addenda: 1, lastAddendumStatus: 'cancelled' }, 'completed')))
        .toEqual({ text: 'Stopped adding 1 late answer', tone: 'stop' });
      expect(addendumOutcome(done([thread('t1', 'Codex', ['completed'])], {}, 'completed'))).toBeNull();
    });
  });

  it('says what happened to a synthesis that was not written', () => {
    const answered = [thread('t1', 'Codex', ['completed'])];
    expect(synthesisNote(view('running', answered))).toBeNull();
    expect(synthesisNote(view('running', answered, { synthesis: { status: 'running' } }))).toBeNull();
    expect(synthesisNote(view('failed', answered, { synthesis: { status: 'failed' } }))).toEqual({ text: "Couldn't write the synthesis", tone: 'fail' });
    expect(synthesisNote(view('cancelled', answered, { synthesis: { status: 'cancelled' } }))?.text).toBe('Stopped while writing the synthesis');
    expect(synthesisNote(view('interrupted', answered, { synthesis: { status: 'interrupted' } }))?.text).toBe('Interrupted while writing the synthesis');
    expect(synthesisNote(view('failed', [thread('t1', 'Codex', ['failed'])]))?.text).toBe('Not written: no branch answered');
    expect(synthesisNote(view('cancelled', [thread('t1', 'Codex', ['cancelled'])]))?.text).toBe('Not written: the run was stopped');
    expect(synthesisNote(view('interrupted', answered))?.text).toBe('Not written: the run was interrupted');
  });
});
