import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TerminalDigest from './Digest';
import ManageComposer from '../manage/ManageComposer';
import { requestDigestFocus } from '../../../state/digestFocus';

const createDigest = vi.hoisted(() => vi.fn());
const markDigestViewed = vi.hoisted(() => vi.fn());
const setDigestPrompt = vi.hoisted(() => vi.fn());
const revealNode = vi.hoisted(() => vi.fn(() => true));
const store = vi.hoisted(() => ({
  project: null as any,
  nodes: {} as Record<string, any>,
}));

vi.mock('../../../state/chatStore', () => ({
  useChatStore: () => ({
    activeProject: store.project,
    createDigest,
    refreshDigest: vi.fn(),
    setDigestPrompt,
    markDigestViewed,
    openPane: vi.fn(),
    revealNode,
    createChildChat: vi.fn(),
  }),
  useChatNodesSnapshot: () => store.nodes,
  useChatNode: (id: string) => store.nodes[id] ?? null,
  chatLabel: (node: any) => node?.title ?? node?.nodeId ?? '',
}));

vi.mock('../../MarkdownContent', () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

vi.mock('../manage/ManageComposer', () => ({
  default: vi.fn(({ onSubmitted }: { onSubmitted: () => void }) => (
    <button onClick={onSubmitted}>Submit digest follow-up</button>
  )),
}));

function chat(id: string, title: string, messageCount = 1) {
  return {
    nodeId: id,
    projectId: 'p1',
    kind: 'chat',
    title,
    status: 'idle',
    messages: [],
    messageCount,
    followUps: [],
  };
}

function digest(id: string, sourceId: string, title: string, generatedAt: number) {
  return {
    nodeId: id,
    projectId: 'p1',
    kind: 'digest',
    title,
    status: 'idle',
    messages: [],
    followUps: [],
    digest: {
      sources: [sourceId],
      sourceFingerprints: {},
      content: `# ${title}\n\n${title} body`,
      generatedAt,
      viewedAt: generatedAt,
      status: 'idle',
    },
  };
}

function project(activeTreeId = 't1') {
  return {
    id: 'p1',
    name: 'Workspace',
    chatIds: ['r1', 'c1', 'r2', 'd1', 'd2'],
    edges: [{ source: 'r1', target: 'c1', kind: 'branch' }],
    trees: [
      { id: 't1', rootNodeId: 'r1', name: 'Current thread', createdAt: 1, lastActiveAt: 1 },
      { id: 't2', rootNodeId: 'r2', name: 'Other thread', createdAt: 2, lastActiveAt: 2 },
    ],
    activeTreeId,
    createdAt: 0,
  };
}

beforeEach(() => {
  createDigest.mockReset().mockResolvedValue('new-digest');
  markDigestViewed.mockReset();
  setDigestPrompt.mockReset();
  revealNode.mockClear();
  vi.mocked(ManageComposer).mockClear();
  store.project = project();
  store.nodes = {
    r1: chat('r1', 'Root one', 2),
    c1: chat('c1', 'Child one', 3),
    r2: chat('r2', 'Root two', 4),
    d1: digest('d1', 'r1', 'Current digest', 10),
    d2: digest('d2', 'r2', 'Other digest', 20),
  };
});

describe('TerminalDigest thread scope', () => {
  it('keeps custom prompt controls out of the Electron drag region and accepts edits', () => {
    render(<TerminalDigest onNav={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'CUSTOM PROMPT' });
    expect(toggle.parentElement?.style.getPropertyValue('-webkit-app-region')
      || (toggle.parentElement?.style as any).WebkitAppRegion).toBe('no-drag');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom digest prompt' }), {
      target: { value: 'Summarize in Chinese' },
    });
    expect(setDigestPrompt).toHaveBeenCalledWith('d1', 'Summarize in Chinese');
  });

  it('shows live thoughts beside partial output and removes them after generation', () => {
    store.nodes.d1.digest = {
      ...store.nodes.d1.digest,
      status: 'streaming',
      content: 'Partial digest output',
      generation: { startedAt: Date.now(), thought: 'Comparing source conversations', activity: 'Writing digest...' },
    };
    const view = render(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Digest thinking' }).textContent).toBe('Comparing source conversations');
    expect(screen.getByText('Partial digest output')).toBeTruthy();
    const rebuild = screen.getByRole('button', { name: /Rebuild/ }) as HTMLButtonElement;
    expect(rebuild.disabled).toBe(true);
    // The shared primary Button (same fill as the composer's Send), with no
    // digest-hued fill of its own.
    expect(rebuild.className).toContain('ui-btn--primary');
    expect(rebuild.style.background).toBe('');
    expect(markDigestViewed).not.toHaveBeenCalled();

    store.nodes.d1 = { ...store.nodes.d1, digest: {
      ...store.nodes.d1.digest, status: 'idle', content: 'Final digest output', generatedAt: 30, generation: undefined,
    } };
    view.rerender(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Digest generation' })).toBeNull();
    expect(screen.queryByText('Comparing source conversations')).toBeNull();
    expect(screen.getByText('Final digest output')).toBeTruthy();
    expect(markDigestViewed).toHaveBeenCalledWith('d1');
  });

  it('takes a source row to that conversation on the Dashboard', () => {
    const onNav = vi.fn();
    render(<TerminalDigest onNav={onNav} />);
    fireEvent.click(screen.getByText('Root one'));
    expect(revealNode).toHaveBeenCalledWith('r1', { workspaceId: 'p1' });
    expect(onNav).toHaveBeenCalledWith('dashboard');
  });

  it('opens a section\'s source from a button the keyboard reaches', () => {
    const onNav = vi.fn();
    store.nodes.d1 = { ...store.nodes.d1, digest: { ...store.nodes.d1.digest, content: '# Current digest\n\n## §01 First point\nsource: r1\n\nBody.' } };
    render(<TerminalDigest onNav={onNav} />);
    const source = screen.getByRole('button', { name: /source/ });
    fireEvent.click(source);
    expect(revealNode).toHaveBeenCalledWith('r1', { workspaceId: 'p1' });
    expect(onNav).toHaveBeenCalledWith('dashboard');
  });

  it('opens on the digest the Map or a digest pane asked for, not the thread\'s newest', () => {
    store.project = { ...project(), chatIds: [...project().chatIds, 'd0'] };
    store.nodes.d0 = digest('d0', 'r1', 'Older digest', 5);
    requestDigestFocus('d0');
    render(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.getByText('Older digest body')).toBeTruthy();
    expect(screen.queryByText('Current digest body')).toBeNull();
  });

  it('shows generation errors instead of an empty digest', () => {
    store.nodes.d1.digest = { ...store.nodes.d1.digest, status: 'error', content: '', error: 'Runtime unavailable' };
    render(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('Runtime unavailable');
    expect(screen.queryByText(/digest is empty/)).toBeNull();
  });

  it('does not render the same summary twice before section headings arrive', () => {
    store.nodes.d1.digest = { ...store.nodes.d1.digest, status: 'streaming', content: '# Title\n\nSummary so far' };
    render(<TerminalDigest onNav={vi.fn()} />);
    expect(screen.getAllByText('Summary so far')).toHaveLength(1);
    expect(screen.queryByText('# Title\n\nSummary so far')).toBeNull();
  });

  it('counts the messages a send added since the thread loaded', () => {
    store.project = { ...project(), chatIds: ['r1', 'c1', 'r2'] };
    const sent = ['u', 'a', 'u2', 'a2'].map((id, i) => ({ id, role: i % 2 ? 'assistant' : 'user', text: id, toolCalls: [] }));
    store.nodes = {
      r1: { ...chat('r1', 'Root one', 2), messages: sent, messagesLoaded: true },
      c1: chat('c1', 'Child one', 3),
      r2: chat('r2', 'Root two', 4),
    };

    render(<TerminalDigest onNav={vi.fn()} />);

    expect(screen.getByText('7 messages')).toBeTruthy();
  });

  it('shows an inline prompt and creates a digest from every chat in the active thread', async () => {
    store.project = {
      ...project(),
      chatIds: ['r1', 'c1', 'r2'],
    };
    store.nodes = {
      r1: chat('r1', 'Root one', 2),
      c1: chat('c1', 'Child one', 3),
      r2: chat('r2', 'Root two', 4),
    };

    render(<TerminalDigest onNav={vi.fn()} />);

    expect(screen.getByText('Create this thread’s digest')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Digest guidance (optional)'), {
      target: { value: 'Focus on decisions and next steps' },
    });
    const create = screen.getByRole('button', { name: 'Create digest' });
    expect(create.className).toContain('ui-btn--primary');
    expect(create.style.background).toBe('');
    fireEvent.click(create);

    await waitFor(() => {
      expect(createDigest).toHaveBeenCalledWith(
        'p1',
        ['r1', 'c1'],
        'Focus on decisions and next steps',
      );
    });
  });
});
