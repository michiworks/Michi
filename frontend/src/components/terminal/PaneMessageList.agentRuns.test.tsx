import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunStatus, type AgentRunDtoV1 } from 'michi-shared';
import * as agentDomain from '../../state/agentDomain';
import * as chatStore from '../../state/chatStore';
import { agentResourceKey, type LocatedAgentResource } from '../../state/agentIdentity';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

// A run card renders its status through FadeOnChange once per render; nothing
// else in these transcripts does.
const { cardRenders } = vi.hoisted(() => ({ cardRenders: { count: 0 } }));
vi.mock('./agentBlockMotion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentBlockMotion')>();
  return {
    ...actual,
    FadeOnChange: (props: Parameters<typeof actual.FadeOnChange>[0]) => {
      cardRenders.count += 1;
      return actual.FadeOnChange(props);
    },
  };
});

const run: LocatedAgentResource<AgentRunDtoV1> = {
  backendConnectionId: 'local',
  value: {
    id: 'run-1', parentMessageId: 'answer', createdAt: 1, startedAt: 1, completedAt: null,
    effectiveDefinition: { name: 'Reviewer', runtimeProfile: { runtimeId: 'pi' } },
    executionEnvironment: { kind: 'shared_workspace' },
    status: AgentRunStatus.Running, task: 'Review the change', resultBundle: null,
  } as AgentRunDtoV1,
};
const runIdentity = { backendConnectionId: run.backendConnectionId, id: run.value.id };
const node: ChatNodeState = {
  nodeId: 'node-1', kind: 'chat', chatId: null, projectId: 'workspace-1',
  status: 'idle', followUps: [],
  messages: [{ id: 'answer', role: 'assistant', text: 'Review in progress', toolCalls: [] }],
};
const noop = () => {};

function list(value = node) {
  return <PaneMessageList
    node={value} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={value.status === 'streaming'}
    onRetryTurn={noop} onEditUserMessage={noop} onContinueFollowUp={noop} onBranchFollowUp={noop}
  />;
}

function runUi() {
  const domain: agentDomain.AgentDomainContextValue = {
    state: { ...agentDomain.initialAgentDomainState, runs: { [agentResourceKey(runIdentity)]: run } },
    loadDefinitions: vi.fn(), loadRuns: vi.fn(), spawn: vi.fn(), reconcileRun: vi.fn(),
    subscribeWorkspace: vi.fn(), sendInput: vi.fn(), cancel: vi.fn(), dispatch: vi.fn(),
  };
  const openAgentRunPane = vi.fn();
  const actions = { openAgentRunPane } as unknown as NonNullable<ReturnType<typeof chatStore.useOptionalChatActions>>;
  return { domain, actions, openAgentRunPane };
}

afterEach(() => vi.restoreAllMocks());

describe('PaneMessageList optional Agent Run contexts', () => {
  it('returns null for absent optional contexts while strict hooks still reject missing providers', () => {
    const { result } = renderHook(() => ({
      domain: agentDomain.useOptionalAgentDomain(),
      actions: chatStore.useOptionalChatActions(),
    }));
    expect(result.current).toEqual({ domain: null, actions: null });
    expect(() => renderHook(() => agentDomain.useAgentDomain())).toThrow('useAgentDomain must be used within AgentDomainProvider');
    expect(() => renderHook(() => chatStore.useChatActions())).toThrow('useChatActions must be used within ChatProvider');
  });

  it.each(['domain', 'actions'] as const)('reads both optional contexts when %s is absent', (missing) => {
    const { domain, actions } = runUi();
    const domainHook = vi.spyOn(agentDomain, 'useOptionalAgentDomain').mockReturnValue(missing === 'domain' ? null : domain);
    const actionsHook = vi.spyOn(chatStore, 'useOptionalChatActions').mockReturnValue(missing === 'actions' ? null : actions);
    render(list());
    expect(screen.getByText('Review in progress')).toBeTruthy();
    expect(screen.queryByTestId('agent-run-card')).toBeNull();
    expect(domainHook).toHaveBeenCalled();
    expect(actionsHook).toHaveBeenCalled();
  });

  it('leaves an earlier message\'s run card alone while a later reply streams', () => {
    const { domain, actions } = runUi();
    vi.spyOn(agentDomain, 'useOptionalAgentDomain').mockReturnValue(domain);
    vi.spyOn(chatStore, 'useOptionalChatActions').mockReturnValue(actions);
    const streaming = (text: string): ChatNodeState => ({
      ...node,
      status: 'streaming',
      messages: [...node.messages, { id: 'u2', role: 'user', text: 'And now?', toolCalls: [] }, { id: 'tail', role: 'assistant', text, toolCalls: [], streaming: true }],
    });
    const { rerender } = render(list(streaming('Look')));
    const rendered = cardRenders.count;
    expect(rendered).toBeGreaterThan(0);
    rerender(list(streaming('Looking')));
    expect(cardRenders.count).toBe(rendered);
  });

  it('opens the matching parent run when both contexts are available', () => {
    const { domain, actions, openAgentRunPane } = runUi();
    vi.spyOn(agentDomain, 'useOptionalAgentDomain').mockReturnValue(domain);
    vi.spyOn(chatStore, 'useOptionalChatActions').mockReturnValue(actions);
    render(list());
    expect(screen.getByTestId('agent-run-card').textContent).toContain('Reviewer');
    fireEvent.click(screen.getByRole('button', { name: 'Open →' }));
    expect(openAgentRunPane).toHaveBeenCalledWith(runIdentity, node.projectId, 'Reviewer');
  });
});
