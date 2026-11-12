import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunDtoV1 } from 'michi-shared';
import type { ChatNodeState, SubagentInfo } from '../../state/chatTypes';
import { AgentBlockStyleOverride, DEFAULT_PREFS } from '../../state/prefs';
import { WorkflowDomainProvider, useOptionalWorkflowDomain, type WorkflowDomainApi } from '../../state/workflowDomain';
import { PaneMessageList } from './PaneMessageList';
import { OPEN_BACKGROUND_WORK_EVENT, type OpenBackgroundWorkDetail } from './backgroundWork/backgroundWorkEvents';

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

// Renders with the message that holds it: counts that message's renders.
const { workflowListRenders } = vi.hoisted(() => ({ workflowListRenders: vi.fn() }));
vi.mock('./workflows/MessageWorkflowRuns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./workflows/MessageWorkflowRuns')>();
  return {
    MessageWorkflowRuns: (props: React.ComponentProps<typeof actual.MessageWorkflowRuns>) => {
      workflowListRenders();
      return <actual.MessageWorkflowRuns {...props} />;
    },
  };
});

const subagent: SubagentInfo = {
  sessionId: 'toolu_agent', parentToolCallId: 'toolu_agent', sessionName: '', agentName: 'Explore', initialQuery: 'Map the auth flow',
  status: 'terminated', outcome: 'completed', group: '', dependsOn: [], prompt: 'Find every cookie reader.', result: 'Three readers.',
};

const node: ChatNodeState = {
  nodeId: 'obs-node',
  kind: 'chat',
  chatId: null,
  projectId: 'obs-ws',
  status: 'idle',
  messagesLoaded: true,
  followUps: [],
  messages: [
    { id: 'ask', role: 'user', text: 'Audit the auth flow.', toolCalls: [] },
    {
      id: 'answer',
      role: 'assistant',
      text: '',
      toolCalls: [
        { id: 'toolu_agent', title: 'Agent', status: 'completed', kind: 'tool', detail: JSON.stringify({ subagent_type: 'Explore', description: 'Map the auth flow' }) },
        { id: 'toolu_wf', title: 'Workflow', status: 'completed', kind: 'tool' },
      ],
      blocks: [
        { id: 'b0', kind: 'tool', toolCallId: 'toolu_agent', section: 'answer', rawOffset: 0 },
        { id: 'b1', kind: 'answer', rawText: 'Delegated the audit.' },
      ],
      subagents: [subagent],
    },
  ],
};

// The same answer with a turn after it, so it is no longer the latest.
const withLaterTurn: ChatNodeState = {
  ...node,
  messages: [
    ...node.messages,
    { id: 'thanks', role: 'user', text: 'Thanks.', toolCalls: [] },
    { id: 'later', role: 'assistant', text: 'Anytime.', toolCalls: [] },
  ],
};

const run: WorkflowRunDtoV1 = {
  version: 1, id: 'wfr_1', runtime: 'claude', nativeId: 'w1', workspaceId: 'obs-ws', nodeId: 'obs-node', parentToolCallId: 'toolu_wf',
  name: 'read-probe', status: 'running', nodes: [], log: [], actions: ['stop'], startedAt: 1, updatedAt: 1, revision: 1,
};

// jsdom has no PointerEvent, so fireEvent would drop pointerType.
class TestPointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

const noop = () => {};
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function recordRequests() {
  const requests: OpenBackgroundWorkDetail[] = [];
  const listener = (event: Event) => requests.push((event as CustomEvent<OpenBackgroundWorkDetail>).detail);
  window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
  cleanups.push(() => window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener));
  return requests;
}

function Subscribe({ workspaceId }: { workspaceId: string }) {
  const domain = useOptionalWorkflowDomain();
  React.useEffect(() => domain?.subscribeWorkspace(workspaceId), [domain, workspaceId]);
  return null;
}

function renderList(initial: ChatNodeState = node) {
  const api: WorkflowDomainApi = {
    get: vi.fn(), act: vi.fn(), answer: vi.fn(),
    subscribe: vi.fn((_workspaceId, options) => { options.onRun(run); return () => {}; }),
  };
  const tree = (current: ChatNodeState) => (
    <AgentBlockStyleOverride.Provider value="card">
      <WorkflowDomainProvider api={api}>
        <Subscribe workspaceId="obs-ws" />
        <PaneMessageList
          node={current}
          prefs={DEFAULT_PREFS}
          contentStyle={{}}
          streaming={current.status === 'streaming'}
          onRetryTurn={noop}
          onEditUserMessage={noop}
          onContinueFollowUp={noop}
          onBranchFollowUp={noop}
        />
      </WorkflowDomainProvider>
    </AgentBlockStyleOverride.Provider>
  );
  const view = render(tree(initial));
  return { ...view, rerenderWith: (next: ChatNodeState) => view.rerender(tree(next)) };
}

describe('PaneMessageList background work links', () => {
  it('a subagent card is one line that opens the drawer on that agent', () => {
    const requests = recordRequests();
    renderList();
    const message = document.querySelector('[data-msg-id="answer"]') as HTMLElement;
    // A finished delegation group starts collapsed.
    if (!within(message).queryByTestId('subagent-card')) fireEvent.click(message.querySelector('button[data-toolgroup-header]')!);
    const card = within(message).getByTestId('subagent-card');
    expect(within(card).queryByTestId('subagent-detail')).toBeNull();
    fireEvent.click(within(card).getByTestId('subagent-summary'));
    expect(requests).toEqual([{ nodeId: 'obs-node', focus: { kind: 'subagent', sessionId: 'toolu_agent' } }]);
  });

  it('a workflow card opens the drawer on its run instead of a pane', async () => {
    const requests = recordRequests();
    renderList();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Open workflow read-probe' }));
    expect(requests).toEqual([{ nodeId: 'obs-node', focus: { kind: 'workflow', runKey: JSON.stringify(['local', 'wfr_1']) } }]);
  });

  // Hung after the message's actions and spacing, the card sat 2px above the
  // next message and read as covering it.
  it('a workflow card sits inside its message, above the message actions', async () => {
    renderList();
    await act(async () => {});
    const block = document.querySelector('[data-msg-id="answer"]')!.firstElementChild as HTMLElement;
    const card = within(block).getByTestId('workflow-run-card');
    const copy = block.querySelector('button[aria-label="copy message"]')!;
    expect(card.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // WebKit drops a tap whose hover makes something visible: a tap on the
  // card that faded in the message's actions only opened the run on the
  // second tap. (The latest answer's actions are always shown, so this is
  // about an earlier one.)
  it('a tap on a workflow card opens the run without revealing the message actions', async () => {
    const requests = recordRequests();
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    cleanups.push(() => {
      fireEvent.pointerOver(document.body, { pointerType: 'mouse' });
      vi.unstubAllGlobals();
    });
    renderList(withLaterTurn);
    await act(async () => {});
    const block = document.querySelector('[data-msg-id="answer"]')!.firstElementChild as HTMLElement;
    const actions = (block.querySelector('button[aria-label="copy message"]') as HTMLElement).parentElement!;
    const tap = (target: Element) => {
      fireEvent.pointerOver(target, { pointerType: 'touch' });
      fireEvent.pointerDown(target, { pointerType: 'touch' });
      fireEvent.mouseOver(target);
      fireEvent.click(target);
    };
    tap(within(block).getByText('read-probe'));
    expect(requests).toHaveLength(1);
    expect(actions.style.opacity).toBe('0');
    // A tap on the reply's text still shows them.
    tap(within(block).getByText('Delegated the audit.'));
    expect(actions.style.opacity).toBe('1');
  });

  it('a mouse over the workflow card still shows the message actions', async () => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    cleanups.push(() => { vi.unstubAllGlobals(); });
    renderList(withLaterTurn);
    await act(async () => {});
    const block = document.querySelector('[data-msg-id="answer"]')!.firstElementChild as HTMLElement;
    const actions = (block.querySelector('button[aria-label="copy message"]') as HTMLElement).parentElement!;
    expect(actions.style.opacity).toBe('0');
    const title = within(block).getByText('read-probe');
    fireEvent.pointerOver(title, { pointerType: 'mouse' });
    fireEvent.mouseOver(title);
    expect(actions.style.opacity).toBe('1');
  });

  it('a later reply streaming does not re-render the message with the workflow card', async () => {
    const reply = { id: 'next', role: 'assistant' as const, text: 'Check', toolCalls: [], streaming: true };
    const live: ChatNodeState = {
      ...node,
      status: 'streaming',
      messages: [...node.messages, { id: 'go', role: 'user', text: 'Go on', toolCalls: [] }, reply],
    };
    const { rerenderWith } = renderList(live);
    await act(async () => {});
    expect(screen.getByTestId('workflow-run-card')).toBeTruthy();
    workflowListRenders.mockClear();
    rerenderWith({ ...live, messages: [...live.messages.slice(0, -1), { ...reply, text: 'Checking' }] });
    expect(workflowListRenders).not.toHaveBeenCalled();
  });
});
