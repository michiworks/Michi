import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react';
import { SUBAGENT_UNTRACKED_ERROR, type BackgroundSubagentsUpdateV1 } from 'michi-shared';
import { ChatNodeStoreContext } from '../../../state/chatStore';
import type { ChatMessage, ChatNodeState, SubagentInfo, ToolCallState } from '../../../state/chatTypes';
import { WorkflowDomainProvider, useOptionalWorkflowDomain, type WorkflowDomainApi } from '../../../state/workflowDomain';
import { ToolCallGroup } from '../ToolCallGroup';
import {
  BackgroundWorkNodeContext,
  OPEN_BACKGROUND_WORK_EVENT,
  type OpenBackgroundWorkDetail,
} from '../backgroundWork/backgroundWorkEvents';
import { SubagentDetail } from './SubagentDetail';
import { MessageSubagents } from './SubagentRoster';
import { delegationStatus, firstPlainLine, subagentDisplayName, subagentRowTitle, subagentSummary, inlineSubagentRoster, withConversationTone, withDelegationStatus } from './subagentPresentation';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** The line's hint, which it carries as its description rather than in its name. */
function hintOf(line: HTMLElement): string | null | undefined {
  const hint = document.getElementById(line.getAttribute('aria-describedby') ?? '');
  return hint?.hidden ? hint.textContent : null;
}

/** Renders inside a conversation and records drawer open requests. */
function inConversation(ui: React.ReactElement) {
  const requests: OpenBackgroundWorkDetail[] = [];
  const listener = (event: Event) => requests.push((event as CustomEvent<OpenBackgroundWorkDetail>).detail);
  window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
  cleanups.push(() => window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener));
  const result = render(<BackgroundWorkNodeContext.Provider value="node-1">{ui}</BackgroundWorkNodeContext.Provider>);
  return { ...result, requests };
}

function subagent(patch: Partial<SubagentInfo> & { sessionId: string }): SubagentInfo {
  return {
    sessionName: '',
    agentName: '',
    initialQuery: '',
    status: 'working',
    group: '',
    dependsOn: [],
    ...patch,
  };
}

const agentTool = (id: string, status = 'in_progress'): ToolCallState => ({
  id,
  title: 'Agent',
  status,
  kind: 'tool',
  detail: JSON.stringify({ subagent_type: 'Explore', description: 'Map the auth flow' }),
});

const finished = subagent({
  sessionId: 'toolu_1',
  parentToolCallId: 'toolu_1',
  agentName: 'Explore',
  description: 'Map the auth flow',
  prompt: 'Find every place the session cookie is read.',
  status: 'terminated',
  outcome: 'completed',
  result: '**Three readers** in `src/auth.ts`.',
  model: 'haiku',
  usage: { totalTokens: 12_400, durationMs: 4_200 },
  source: 'claude',
  activity: [
    { id: 'c1', kind: 'tool', title: 'Read src/auth.ts', status: 'completed', toolKind: 'Read', detail: 'src/auth.ts', output: 'export function readCookie() {}', startedAt: 1_000, endedAt: 1_400 },
    { id: 'm1', kind: 'message', title: 'Checking the middleware next' },
  ],
});

describe('SubagentDetail', () => {
  it('shows the task, the activity trail, the result and the cost', () => {
    const { getByTestId, getAllByTestId, getByText, queryByText } = render(<SubagentDetail subagent={finished} />);
    expect(getByTestId('subagent-task').textContent).toBe('Find every place the session cookie is read.');
    const rows = getAllByTestId('subagent-activity-row');
    expect(rows.map((row) => row.getAttribute('data-activity-kind'))).toEqual(['tool', 'message']);
    expect(getByTestId('subagent-result').querySelector('strong')?.textContent).toBe('Three readers');
    // Its length is on its row, not repeated here.
    expect(getByTestId('subagent-meta').textContent).toBe('haiku·12k tokens·1 tool·claude');

    // Tool output stays folded until the row is opened.
    expect(queryByText('export function readCookie() {}')).toBeNull();
    fireEvent.click(within(rows[0]).getByRole('button'));
    expect(getByText('export function readCookie() {}')).toBeTruthy();
  });

  it('folds a long task and reports dropped steps', () => {
    const long = subagent({
      sessionId: 's',
      prompt: 'x'.repeat(900),
      activity: [{ id: 'a', kind: 'tool', title: 'Bash', status: 'in_progress' }],
      activityDropped: 4,
      currentTool: 'Bash',
    });
    const { getByTestId, getByText } = render(<SubagentDetail subagent={long} />);
    expect(getByTestId('subagent-task').textContent?.length).toBeLessThan(700);
    expect(getByText('Show full task').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(getByText('Show full task'));
    expect(getByTestId('subagent-task').textContent).toHaveLength(900);
    expect(getByText('Show less').getAttribute('aria-controls')).toBe(getByTestId('subagent-task').id);
    expect(getByText('Show less').getAttribute('aria-expanded')).toBe('true');
    expect(getByText('4 earlier steps not kept')).toBeTruthy();
    expect(getByText('Steps')).toBeTruthy();
    // The step at work says "now", in no run colour.
    expect(getByText('now').getAttribute('style')).not.toContain('var(--term-run)');
  });

  it('gives a stopped agent\'s reason a neutral label and keeps a failure red under error', () => {
    const interrupted = subagent({ sessionId: 's', status: 'terminated', background: true, outcome: 'cancelled', error: SUBAGENT_UNTRACKED_ERROR });
    const { getByTestId, getByText, queryByText, unmount } = render(<SubagentDetail subagent={interrupted} active={false} />);
    const reason = getByTestId('subagent-error');
    expect(reason.textContent).toBe(SUBAGENT_UNTRACKED_ERROR);
    expect(reason.getAttribute('data-error-tone')).toBe('stopped');
    expect(reason.getAttribute('style')).toContain('var(--term-mid)');
    expect(reason.getAttribute('style')).not.toContain('var(--term-danger)');
    const label = getByText('Why it stopped');
    expect(label.getAttribute('style')).toContain('var(--term-muted)');
    expect(queryByText('Error')).toBeNull();
    unmount();

    const failed = subagent({ sessionId: 'f', status: 'terminated', outcome: 'failed', error: 'boom' });
    const view = render(<SubagentDetail subagent={failed} />);
    const error = view.getByTestId('subagent-error');
    expect(error.getAttribute('data-error-tone')).toBe('error');
    expect(error.getAttribute('style')).toContain('var(--term-danger-text)');
    expect(view.getByText('Error').getAttribute('style')).toContain('var(--term-danger-text)');
    expect(view.queryByText('Why it stopped')).toBeNull();
  });
});

describe('delegation status', () => {
  it('follows an exactly linked agent past its launch receipt', () => {
    const backgrounded = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1' });
    expect(delegationStatus(agentTool('toolu_1', 'completed'), [backgrounded])).toBe('in_progress');
    expect(delegationStatus(agentTool('toolu_1', 'completed'), [{ ...backgrounded, status: 'terminated', outcome: 'failed' }])).toBe('failed');
  });

  it('only trusts a heuristic legacy match while the chip runs', () => {
    const legacy = subagent({ sessionId: 'kiro-1', agentName: 'Explore' });
    expect(delegationStatus(agentTool('t1', 'in_progress'), [legacy])).toBe('in_progress');
    expect(delegationStatus(agentTool('t1', 'completed'), [legacy])).toBe('completed');
  });

  it('keeps a crew working while any agent works and fails it only when all failed', () => {
    const crew: ToolCallState = { id: 'crew', title: 'Spawning agent crew', status: 'completed', kind: 'other' };
    const a = subagent({ sessionId: 'a', parentToolCallId: 'crew', status: 'terminated', outcome: 'failed' });
    const b = subagent({ sessionId: 'b', parentToolCallId: 'crew' });
    expect(delegationStatus(crew, [a, b])).toBe('in_progress');
    expect(delegationStatus(crew, [a, { ...b, status: 'terminated', outcome: 'completed' }])).toBe('completed');
    expect(delegationStatus(crew, [a, { ...b, status: 'terminated', outcome: 'failed' }])).toBe('failed');
  });

  it('keeps a crew running while its own call runs, after every stage stopped', () => {
    const crew: ToolCallState = { id: 'crew', title: 'Spawning agent crew', status: 'in_progress', kind: 'other' };
    const stopped = (sessionId: string) => subagent({ sessionId, parentToolCallId: 'crew', status: 'terminated', outcome: 'cancelled' });
    expect(delegationStatus(crew, [stopped('a'), stopped('b')])).toBe('in_progress');
    expect(delegationStatus({ ...crew, status: 'completed' }, [stopped('a'), stopped('b')])).toBe('completed');
  });

  it('rewrites only delegation chips and keeps identity when nothing changes', () => {
    const tools = [agentTool('toolu_1', 'completed'), { id: 'r', title: 'Read x', status: 'completed', kind: 'read' }];
    const roster = [subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1' })];
    const next = withDelegationStatus(tools, roster);
    expect(next[0].status).toBe('in_progress');
    expect(next[1]).toBe(tools[1]);
    expect(withDelegationStatus(tools, [])).toBe(tools);
  });

  it('gives a lone delegation\'s chrome the conversation\'s failure and runs it only while both copies run', () => {
    const status = (own: string, tone: Parameters<typeof withConversationTone>[1]) => withConversationTone([agentTool('toolu_1', own)], tone)[0].status;
    expect(status('completed', 'failed')).toBe('failed');
    expect(status('in_progress', 'failed')).toBe('failed');
    expect(status('in_progress', 'running')).toBe('in_progress');
    // A background agent a later turn carries working: its own turn is over.
    expect(status('completed', 'running')).toBe('completed');
    for (const tone of ['completed', 'cancelled', 'background', 'ended'] as const) {
      expect(status('in_progress', tone)).toBe('completed');
      expect(status('failed', tone)).toBe('completed');
    }
    const lone = [agentTool('toolu_1', 'completed')];
    expect(withConversationTone(lone, 'completed')).toBe(lone);
    expect(withConversationTone(lone, undefined)).toBe(lone);
    const several = [agentTool('toolu_1', 'in_progress'), agentTool('toolu_2', 'in_progress')];
    expect(withConversationTone(several, 'completed')).toBe(several);
  });
});

describe('delegation chips with a linked roster', () => {
  it('one line with name, result and status that opens the drawer', () => {
    const tool: ToolCallState = { id: 'toolu_1', title: 'Task', status: 'completed', kind: 'subagent' };
    const { getByTestId, requests } = inConversation(<ToolCallGroup tools={[tool]} subagents={[finished]} />);
    const card = getByTestId('subagent-card');
    const line = within(card).getByTestId('subagent-summary');
    expect(line.tagName).toBe('BUTTON');
    expect(line.textContent).toContain('Explore');
    expect(line.textContent).toContain('Three readers in src/auth.ts.');
    expect(line.textContent).toContain('completed');
    expect(within(card).queryByTestId('subagent-detail')).toBeNull();
    fireEvent.click(line);
    expect(requests).toEqual([{ nodeId: 'node-1', focus: { kind: 'subagent', sessionId: 'toolu_1' } }]);
  });

  it('renders a static line outside a conversation and for a chip without a roster', () => {
    const { getByTestId, unmount } = render(<ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} subagents={[finished]} />);
    expect(getByTestId('subagent-summary').tagName).toBe('DIV');
    expect(getByTestId('subagent-summary').textContent).toContain('Three readers in src/auth.ts.');
    unmount();
    const { getByTestId: get } = inConversation(<ToolCallGroup tools={[agentTool('toolu_2')]} />);
    const line = get('subagent-summary');
    expect(line.tagName).toBe('DIV');
    expect(line.textContent).toContain('Map the auth flow');
  });

  it("marks a completed agent with the drawer's green ✓ and a stopped one with the quiet dot", () => {
    const green = (row: HTMLElement) => [...row.querySelectorAll('[style]')].filter((el) => el.getAttribute('style')?.includes('var(--term-digest)'));
    const line = (subagent: SubagentInfo) => render(<ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} subagents={[subagent]} />);
    const done = line(finished);
    const [check, word] = green(done.getByTestId('subagent-summary'));
    expect(check.querySelector('svg')).not.toBeNull();
    expect(word.textContent).toBe('completed');
    done.unmount();
    // Its tool status reads completed too; its own tone says stopped.
    const stopped = line({ ...finished, outcome: 'cancelled' });
    expect(green(stopped.getByTestId('subagent-summary'))).toEqual([]);
    expect(stopped.getByTestId('subagent-summary').querySelector('.term-dot-i')).not.toBeNull();
  });
});

describe('subagent summaries', () => {
  it('says what runs now, else what came back, else the mission', () => {
    const base = subagent({ sessionId: 's', description: 'Map the auth flow' });
    expect(subagentSummary({ ...base, currentTool: 'Read a.ts' }, { running: true })).toEqual({ tone: 'now', text: 'Read a.ts' });
    expect(subagentSummary({ ...base, statusMessage: 'Checking middleware' }, { running: true })).toEqual({ tone: 'status', text: 'Checking middleware' });
    expect(subagentSummary(finished, { running: false })).toEqual({ tone: 'result', text: 'Three readers in src/auth.ts.' });
    expect(subagentSummary({ ...finished, outcome: 'failed', error: 'boom\ntrace' }, { running: false })).toEqual({ tone: 'error', text: 'boom' });
    // A stale "working" roster under a completed chip does not claim a now line.
    expect(subagentSummary({ ...base, currentTool: 'Glob' }, { running: false })).toEqual({ tone: 'mission', text: 'Map the auth flow' });
    expect(subagentSummary(undefined, { running: true, fallback: 'From the tool input' })).toEqual({ tone: 'mission', text: 'From the tool input' });
    expect(subagentSummary(undefined, { running: true })).toBeUndefined();
  });

  it('titles a drawer row by its task, with the agent type as its label', () => {
    expect(subagentRowTitle(subagent({ sessionId: 's', agentName: 'general-purpose', description: 'Triage failing E2E group C' })))
      .toEqual({ title: 'Triage failing E2E group C', kind: 'general-purpose' });
    // A plugin agent's name drops its plugin; a placeholder name is no type.
    expect(subagentRowTitle(subagent({ sessionId: 's', agentName: 'Builder:pipeline-assistant', description: 'Diagnose the deploy' })).kind).toBe('pipeline-assistant');
    expect(subagentRowTitle(subagent({ sessionId: 's', agentName: 'subagent', description: 'Diagnose the deploy' }))).toEqual({ title: 'Diagnose the deploy' });
    // No task: the name is the title, said once.
    expect(subagentRowTitle(subagent({ sessionId: 's', agentName: 'Explore' }))).toEqual({ title: 'Explore' });
  });

  it('strips markdown from a first line', () => {
    expect(firstPlainLine('\n## **Summary**\nrest')).toBe('Summary');
    expect(firstPlainLine('- `a.ts` changed')).toBe('a.ts changed');
    expect(firstPlainLine('   ')).toBeUndefined();
  });
});

describe('background agents', () => {
  it('reads "in background" on the spawning message instead of ended', () => {
    const bg = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan' });
    const { getByTestId, requests } = inConversation(<ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} subagents={[bg]} />);
    const line = getByTestId('subagent-summary');
    expect(getByTestId('subagent-card').textContent).toMatch(/in background(?! work)/);
    expect(line.hasAttribute('aria-label')).toBe(false);
    expect(within(getByTestId('subagent-card')).getByRole('button', { name: 'Explore Map the auth flow in background' })).toBe(line);
    expect(hintOf(line)).toBe('Show in background work');
    fireEvent.click(line);
    expect(requests).toEqual([{ nodeId: 'node-1', focus: { kind: 'subagent', sessionId: 'toolu_1' } }]);
  });

  /**
   * A delegation chip in the first assistant message of conversation
   * node-1, rendered inside a store the test drives (`show` replaces the
   * conversation's messages after the launch message, and sets its status).
   */
  function launchedInConversation(launch: SubagentInfo) {
    const tools = [agentTool('toolu_1', 'completed')];
    const launched: ChatMessage[] = [
      { id: 'u1', role: 'user', text: 'go', toolCalls: [] },
      { id: 'a1', role: 'assistant', text: '', toolCalls: tools, subagents: [launch] },
    ];
    const conversation = (messages: ChatMessage[], status: ChatNodeState['status'] = 'idle'): ChatNodeState => ({ nodeId: 'node-1', kind: 'chat', chatId: null, projectId: 'ws', messages, followUps: [], status } as ChatNodeState);
    let current = conversation(launched);
    const listeners = new Set<() => void>();
    const store = {
      getNode: (id: string) => (id === 'node-1' ? current : undefined),
      getNodes: () => ({ 'node-1': current }),
      subscribeNode: (_id: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      subscribe: () => () => {},
      getStructureVersion: () => 0,
      subscribeStructure: () => () => {},
    };
    // The workflow-runs feed, which also says which background agents a live process tracks.
    const feeds: Array<Parameters<WorkflowDomainApi['subscribe']>[1]> = [];
    const api: WorkflowDomainApi = {
      get: vi.fn(), act: vi.fn(), answer: vi.fn(),
      subscribe: vi.fn((_workspaceId, options) => { feeds.push(options); return () => {}; }),
    };
    function Subscribe() {
      const domain = useOptionalWorkflowDomain();
      React.useEffect(() => domain?.subscribeWorkspace('ws'), [domain]);
      return null;
    }
    const { getByTestId } = inConversation(
      <ChatNodeStoreContext.Provider value={store}>
        <WorkflowDomainProvider api={api}>
          <Subscribe />
          <ToolCallGroup tools={tools} subagents={[launch]} />
        </WorkflowDomainProvider>
      </ChatNodeStoreContext.Provider>,
    );
    return {
      line: () => getByTestId('subagent-summary'),
      show: (later: ChatMessage[], status?: ChatNodeState['status']) => {
        current = conversation([...launched, ...later], status);
        act(() => { for (const listener of listeners) listener(); });
      },
      live: (update: BackgroundSubagentsUpdateV1) => act(() => feeds[0].onBackgroundSubagents?.(update)),
    };
  }

  it('reads stopped once no live process tracks it, and in background while one does', () => {
    const launch = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan', startedAt: 1_000, endedAt: 13_000 });
    const { line, live } = launchedInConversation(launch);
    expect(line().textContent).toMatch(/in background(?! work)/);
    live({ snapshot: true, nodes: { 'node-1': ['toolu_1'] } });
    expect(line().textContent).toMatch(/in background(?! work)/);

    // The process that ran it ended before it reported back.
    live({ snapshot: false, nodes: { 'node-1': [] } });
    expect(line().textContent).toContain(SUBAGENT_UNTRACKED_ERROR.split('\n')[0]);
    expect(line().textContent).toContain('stopped');
    expect(line().textContent).not.toMatch(/in background(?! work)|working/);
    expect(within(line()).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');
  });

  it('reads stopped, with no now line, when the working agent\'s process ended before its turn did', () => {
    // The app quit mid-turn: the launch turn never closed its roster.
    const launch = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', background: true, currentTool: 'Read a.ts', prompt: 'Scan', startedAt: 1_000 });
    const { line, live } = launchedInConversation(launch);
    expect(within(line()).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('now');
    expect(line().textContent).toContain('❯ Read a.ts');
    live({ snapshot: true, nodes: {} });
    expect(within(line()).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');
    expect(line().textContent).toContain(SUBAGENT_UNTRACKED_ERROR.split('\n')[0]);
    expect(line().textContent).toContain('stopped');
    expect(line().textContent).not.toContain('❯');
    expect(line().textContent).not.toContain('Read a.ts');
    expect(line().textContent).not.toMatch(/working/);
  });

  it('reads as the conversation knows it once a later turn brought its completion', () => {
    const launch = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan', startedAt: 1_000, endedAt: 13_000 });
    const { line, show } = launchedInConversation(launch);
    // (The hidden hint "Show in background work" is not the status.)
    expect(line().textContent).toMatch(/in background(?! work)/);
    // No duration while it runs: 12s was its launch turn, not the agent.
    expect(line().textContent).not.toContain('12s');

    // The CLI's own turn carries the completion.
    show([{ id: 'self', role: 'assistant', text: '', toolCalls: [], subagents: [subagent({ sessionId: 'toolu_1', status: 'terminated', outcome: 'completed', result: 'Found **two** readers.', usage: { durationMs: 42_000 } })] }]);
    expect(line().textContent).toContain('Found two readers.');
    expect(line().textContent).toContain('completed');
    expect(line().textContent).toContain('42s');
    expect(line().textContent).not.toMatch(/in background(?! work)/);
  });

  it('keeps its outcome and result when a later turn reports it closed without one', () => {
    // A Codex child completed in a1; closing it in a2 reports a bare terminated state.
    const completed = subagent({
      sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', outcome: 'completed',
      result: 'Found 3 issues', usage: { durationMs: 9_000 }, startedAt: 1_000, endedAt: 10_000,
    });
    const { line, show } = launchedInConversation(completed);
    const name = 'Explore Found 3 issues completed 9.0s';
    expect(line().textContent).toContain('Found 3 issues');
    show([
      { id: 'u2', role: 'user', text: 'close it', toolCalls: [] },
      { id: 'a2', role: 'assistant', text: '', toolCalls: [], subagents: [subagent({ sessionId: 'toolu_1', status: 'terminated' })] },
    ]);
    expect(within(line()).queryByText('ended')).toBeNull();
    expect(line().textContent).toContain('Found 3 issues');
    expect(line().textContent).toContain('completed');
    expect(within(document.body).getByRole('button', { name })).toBe(line());
  });

  it('reads stopped with its error once a restart interrupted it', () => {
    const launch = subagent({ sessionId: 'toolu_1', parentToolCallId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan', startedAt: 1_000, endedAt: 13_000 });
    const { line, show } = launchedInConversation(launch);
    show([{ id: 'a2', role: 'assistant', text: '', toolCalls: [], subagents: [subagent({
      sessionId: 'toolu_1', status: 'terminated', background: true, outcome: 'cancelled', endedAt: 40_000,
      error: 'Interrupted: Michi restarted while this subagent was running\nexit code 143',
    })] }]);
    expect(line().textContent).toContain('Interrupted: Michi restarted while this subagent was running');
    expect(line().textContent).not.toContain('exit code 143');
    expect(line().textContent).toContain('stopped');
    expect(line().textContent).not.toMatch(/in background(?! work)|working/);
    expect(within(line()).getByTestId('subagent-summary-text').getAttribute('data-summary-tone')).toBe('error');

    // Recorded in place on its own copy, it reads the same.
    const interrupted = { ...launch, outcome: 'cancelled' as const, endedAt: 40_000, error: 'Interrupted: Michi restarted while this subagent was running' };
    const { container } = inConversation(<ToolCallGroup tools={[agentTool('toolu_1', 'completed')]} subagents={[interrupted]} />);
    const own = within(container).getByTestId('subagent-summary');
    expect(own.textContent).toContain('Interrupted: Michi restarted while this subagent was running');
    expect(own.textContent).toContain('stopped');
    expect(own.textContent).not.toMatch(/in background(?! work)|working/);
  });

  it('explains a background agent in its detail', () => {
    const bg = subagent({ sessionId: 'toolu_1', agentName: 'Explore', status: 'terminated', background: true, prompt: 'Scan' });
    const { getByText } = render(<SubagentDetail subagent={bg} />);
    expect(getByText(/Its result arrives with a later reply/)).toBeTruthy();
  });

  it('names Codex children by thread id when they have no nickname', () => {
    const child = subagent({ sessionId: '01a13922-817a', source: 'codex', status: 'terminated', outcome: 'completed' });
    expect(subagentDisplayName(child)).toContain('Codex 01a13922');
  });
});

describe('message-level roster', () => {
  const rosterNode = (subagents: SubagentInfo[], toolCalls: ToolCallState[]): ChatNodeState => ({
    nodeId: 'node-1', kind: 'chat', chatId: null, projectId: 'ws', followUps: [], status: 'idle',
    messages: [{ id: 'a1', role: 'assistant', text: '', toolCalls, subagents }],
  } as ChatNodeState);

  it('shows only agents no chip in the message claims', () => {
    const crewAgent = subagent({ sessionId: 'crew-1', agentName: 'researcher', source: 'crew' });
    const roster = inlineSubagentRoster(rosterNode([finished, crewAgent], [agentTool('toolu_1', 'completed')]));
    expect(roster?.subagents.map((entry) => entry.sessionId)).toEqual(['crew-1']);

    const { getByTestId } = render(<MessageSubagents subagents={roster!.subagents} />);
    expect(getByTestId('message-subagents').textContent).toBe('Subagents1 working');
  });

  it('counts the agents by state on one line, without their results', () => {
    const roster = [
      subagent({ sessionId: 'run-1', agentName: 'researcher', status: 'working' }),
      subagent({ sessionId: 'bg-1', agentName: 'Explore', status: 'terminated', background: true }),
      finished,
      subagent({ sessionId: 'fail-1', agentName: 'Explore', status: 'terminated', outcome: 'failed', error: 'Tool crashed' }),
      subagent({ sessionId: 'stop-1', agentName: 'Explore', status: 'terminated', outcome: 'cancelled', error: SUBAGENT_UNTRACKED_ERROR }),
    ];
    const { getByTestId, queryAllByTestId, getByRole } = render(<MessageSubagents subagents={roster} />);
    // An agent in background still works; an interrupted one reads stopped.
    expect(getByTestId('message-subagents').textContent).toBe('Subagents2 working·1 done·1 failed·1 stopped');
    expect(queryAllByTestId('subagent-row')).toHaveLength(0);
    expect(getByRole('region', { name: '5 subagents' })).toBeTruthy();
    // Outside a conversation there is no drawer to open.
    expect(getByTestId('message-subagents').tagName).toBe('SECTION');
  });

  it('opens the background work drawer from the line', () => {
    const { getByTestId, requests } = inConversation(<MessageSubagents subagents={[finished]} />);
    const line = getByTestId('message-subagents');
    expect(line.tagName).toBe('BUTTON');
    expect(line.textContent).toContain('1 done');
    expect(hintOf(line)).toBe('Show in background work');
    fireEvent.click(line);
    expect(requests).toEqual([{ nodeId: 'node-1', subagentIds: ['toolu_1'] }]);
  });

  it('renders nothing when every agent is claimed', () => {
    expect(inlineSubagentRoster(rosterNode([finished], [agentTool('toolu_1')]))).toBeUndefined();
    const { container } = render(<MessageSubagents subagents={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
