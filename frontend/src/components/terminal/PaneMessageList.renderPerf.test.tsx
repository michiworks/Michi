import type React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaneMessageList } from './PaneMessageList';
import type { ChatMessage, ChatNodeState } from '../../state/chatTypes';
import type { Prefs } from '../../state/prefs';
import { DEFAULT_PREFS } from '../../state/prefs';
import { STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY } from './streamingMarkdownBlocksFlag';

const { markdownRenderSpy, chromeRenders, rendered } = vi.hoisted(() => {
  const chromeRenders = new Map<string, number>();
  const rendered = (name: string) => chromeRenders.set(name, (chromeRenders.get(name) ?? 0) + 1);
  return { markdownRenderSpy: vi.fn(), chromeRenders, rendered };
});

vi.mock('../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => {
    markdownRenderSpy(text);
    return <span>{text}</span>;
  },
}));

// Each tail part calls one of these once per render, so their counts are the parts'.
vi.mock('../../hooks/useNow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/useNow')>();
  return { useNow: (intervalMs: number, enabled?: boolean) => {
    rendered('activity row');
    return actual.useNow(intervalMs, enabled);
  } };
});
vi.mock('./icons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./icons')>();
  const counted = <P,>(name: string, Icon: (props: P) => React.ReactNode) => (props: P) => {
    rendered(name);
    return Icon(props);
  };
  return {
    ...actual,
    ChatIcon: counted('merge notice', actual.ChatIcon),
    WarningIcon: counted('MCP error', actual.WarningIcon),
    SpinnerIcon: counted('follow-ups', actual.SpinnerIcon),
  };
});

function makeMsg(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  streaming = false,
): ChatMessage {
  return { id, role, text, toolCalls: [], streaming };
}

function makeNode(messages: ChatMessage[]): ChatNodeState {
  return {
    nodeId: 'n1',
    kind: 'chat',
    chatId: null,
    projectId: 'p1',
    messages,
    followUps: [],
    status: 'streaming',
  } as ChatNodeState;
}

const prefs: Prefs = { ...DEFAULT_PREFS, showThoughts: true };
// Stable across renders, as TPane's handlers are.
const handlers = { onRetryTurn: vi.fn(), onEditUserMessage: vi.fn(), onContinueFollowUp: vi.fn(), onBranchFollowUp: vi.fn() };

function renderList(node: ChatNodeState, onOpenBranch: (id: string) => void) {
  return (
    <PaneMessageList
      node={node}
      prefs={prefs}
      contentStyle={{}}
      streaming
      {...handlers}
      anchorsByMessage={new Map()}
      onOpenBranch={onOpenBranch}
    />
  );
}

describe('PaneMessageList render performance', () => {
  beforeEach(() => {
    markdownRenderSpy.mockClear();
    window.localStorage.removeItem(STREAMING_MARKDOWN_BLOCKS_STORAGE_KEY);
  });

  it('skips the tail chrome on a streamed chunk', () => {
    chromeRenders.clear();
    const u1 = makeMsg('u1', 'user', 'question');
    const node: ChatNodeState = {
      ...makeNode([u1, makeMsg('a1', 'assistant', 'stream one', true)]),
      streamingStartedAt: 1,
      mergeSources: ['n-source'],
      mcpServerError: { serverName: 'treg', error: 'Connection refused' },
      followUpsGenerating: true,
    };
    const onOpenBranch = vi.fn();
    const { rerender } = render(renderList(node, onOpenBranch));
    const before = Object.fromEntries(chromeRenders);
    expect(Object.keys(before).sort()).toEqual(['MCP error', 'activity row', 'follow-ups', 'merge notice']);

    // A chunk commit: a new node and messages array, every other field kept.
    rerender(renderList({ ...node, messages: [u1, makeMsg('a1', 'assistant', 'stream one two', true)] }, onOpenBranch));
    expect(Object.fromEntries(chromeRenders)).toEqual(before);
  });

  it('does not re-render stable assistant markdown when only the streaming tail changes', () => {
    const u1 = makeMsg('u1', 'user', 'first question');
    const a1 = makeMsg('a1', 'assistant', 'stable answer');
    const u2 = makeMsg('u2', 'user', 'second question');
    const a2 = makeMsg('a2', 'assistant', 'stream one', true);
    const onOpenBranch = vi.fn();

    const { rerender } = render(renderList(makeNode([u1, a1, u2, a2]), onOpenBranch));
    rerender(renderList(makeNode([u1, a1, u2, { ...a2, text: 'stream two' }]), onOpenBranch));

    const renderedTexts = markdownRenderSpy.mock.calls.map((call) => call[0]);
    expect(renderedTexts.filter((text) => text === 'stable answer')).toHaveLength(1);
    expect(renderedTexts).toContain('stream one');
    expect(renderedTexts).toContain('stream two');
  });
});
