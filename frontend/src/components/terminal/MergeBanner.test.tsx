import { act, render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import MergeBanner from './MergeBanner';

// Mock the chatStore module so we can control hook return values.
vi.mock('../../state/chatStore', () => ({
  useChatStore: vi.fn(),
  useChatActions: vi.fn(),
  useChatNodesSnapshot: vi.fn(),
}));

// Mock the estimate so we can control it; the merged node set stays real.
vi.mock('../../state/mergePreamble', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../state/mergePreamble')>(),
  estimateMergePreambleTokens: vi.fn(),
}));

import * as chatStoreModule from '../../state/chatStore';
import * as mergePreambleModule from '../../state/mergePreamble';

function makeActiveProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'Test',
    chatIds: ['n-merge', 'n-1', 'n-2'],
    edges: [
      { source: 'n-1', target: 'n-merge', kind: 'merge' },
      { source: 'n-2', target: 'n-merge', kind: 'merge' },
    ],
    createdAt: 0,
    trees: [],
    activeTreeId: null,
    artifacts: [],
    ...overrides,
  };
}

function makeStore(overrides: Record<string, unknown> = {}) {
  return {
    activeProject: makeActiveProject(),
    ...overrides,
  };
}

function makeNodes(overrides: Record<string, unknown> = {}) {
  return {
    'n-1': {
      id: 'n-1',
      title: 'Thread A',
      messages: [{ role: 'user', text: 'hello', id: 'msg-1', toolCalls: [] }],
      mergeSources: undefined,
      deletedAt: undefined,
    },
    'n-2': {
      id: 'n-2',
      title: 'Thread B',
      messages: [{ role: 'user', text: 'world', id: 'msg-2', toolCalls: [] }],
      mergeSources: undefined,
      deletedAt: undefined,
    },
    'n-merge': {
      id: 'n-merge',
      title: 'Merged',
      messages: [],
      mergeSources: ['n-1', 'n-2'],
      deletedAt: undefined,
    },
    ...overrides,
  };
}

const ensureCompleteHistory = vi.fn();

describe('MergeBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureCompleteHistory.mockResolvedValue({});
    vi.mocked(chatStoreModule.useChatActions).mockReturnValue({ ensureCompleteHistory } as never);
    vi.mocked(chatStoreModule.useChatStore).mockReturnValue(makeStore() as never);
    vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(makeNodes() as never);
    vi.mocked(mergePreambleModule.estimateMergePreambleTokens).mockReturnValue(0);
  });

  it('renders nothing when node already has messages (first message sent)', () => {
    vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(
      makeNodes({
        'n-merge': {
          id: 'n-merge',
          title: 'Merged',
          messages: [{ role: 'user', text: 'first msg', id: 'msg-x', toolCalls: [] }],
          mergeSources: ['n-1', 'n-2'],
          deletedAt: undefined,
        },
      }) as never,
    );

    const { container } = render(<MergeBanner nodeId="n-merge" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when estimated tokens are at or below 32k', () => {
    vi.mocked(mergePreambleModule.estimateMergePreambleTokens).mockReturnValue(32_000);

    const { container } = render(<MergeBanner nodeId="n-merge" />);
    expect(container.firstChild).toBeNull();
  });

  it('can be dismissed — banner disappears after clicking Dismiss', () => {
    vi.mocked(mergePreambleModule.estimateMergePreambleTokens).mockReturnValue(40_000);

    render(<MergeBanner nodeId="n-merge" />);
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('loads a merged thread that has not been opened before estimating it', async () => {
    let release!: () => void;
    ensureCompleteHistory.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
    vi.mocked(mergePreambleModule.estimateMergePreambleTokens).mockReturnValue(40_000);
    const placeholder = makeNodes({ 'n-2': { id: 'n-2', title: 'Thread B', messages: [], messagesLoaded: false } });
    vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(placeholder as never);

    const { rerender } = render(<MergeBanner nodeId="n-merge" />);
    expect(ensureCompleteHistory).toHaveBeenCalledWith(['n-2']);
    expect(screen.queryByRole('alert')).toBeNull();

    // Loaded: the store now holds its whole history.
    vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(makeNodes() as never);
    await act(async () => { release(); });
    rerender(<MergeBanner nodeId="n-merge" />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(ensureCompleteHistory).toHaveBeenCalledTimes(1);
  });

  it('estimates what it has when the history cannot be loaded', async () => {
    ensureCompleteHistory.mockRejectedValue(new Error('offline'));
    vi.mocked(mergePreambleModule.estimateMergePreambleTokens).mockReturnValue(40_000);
    vi.mocked(chatStoreModule.useChatNodesSnapshot).mockReturnValue(
      makeNodes({ 'n-2': { id: 'n-2', title: 'Thread B', messages: [], messagesLoaded: false } }) as never,
    );
    render(<MergeBanner nodeId="n-merge" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(ensureCompleteHistory).toHaveBeenCalledTimes(1);
  });
});
