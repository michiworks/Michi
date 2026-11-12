import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, act, screen } from '@testing-library/react';
import TPane from './TPane';
import { paneFileDropTarget } from './paneFileDropTargets';
import type { ChatNodeState } from '../../state/chatTypes';
import type { MentionRecord } from '../../lib/mentions';

const mockNode: ChatNodeState = {
  nodeId: 'n1', chatId: null, projectId: 'p1', kind: 'chat',
  title: 't', messages: [], followUps: [], status: 'idle',
};

const mockProject = {
  id: 'p1', name: 'P', cwd: '/tmp/p1', chatIds: ['n1'], edges: [],
  trees: [{ id: 'tr1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 0 }],
  activeTreeId: 'tr1', artifacts: [], createdAt: 0,
};

// The embedded assistant's hidden workspace, beside the shell's active p1.
const assistantProject: typeof mockProject & { system?: 'assistant' } = { ...mockProject, id: 'ws-assistant', cwd: '/data/assistant/.michi', chatIds: [] };

const importUploadFn = vi.hoisted(() => vi.fn());
vi.mock('../../services/api', async () => ({
  ...await vi.importActual<any>('../../services/api'),
  importWorkspaceFileUpload: importUploadFn,
}));

const createContextFn = vi.fn();
const focusPaneFn = vi.fn();
const setComposerDraftFn = vi.fn();
const sendMessageFn = vi.fn();
const queueMessageFn = vi.fn();
const cancelStreamFn = vi.fn();
const steerMessageFn = vi.fn();
const addPendingCommentFn = vi.fn();
let mockCanSteer = false;
let mockEditorMentions: MentionRecord[] = [];

vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  const actions = () => ({
    createContext: createContextFn,
    focusPane: focusPaneFn,
    closePane: () => {},
    reorderPane: () => {},
    sendMessage: sendMessageFn,
    retryLastTurn: () => {},
    cancelStream: cancelStreamFn,
    createChildChat: () => Promise.resolve(),
    fanoutBranches: () => Promise.resolve(),
    setFocusedNodeId: () => {},
    switchAgent: () => Promise.resolve(),
    resolvePermission: () => {},
    denyPermission: () => {},
    addPendingComment: addPendingCommentFn,
    removePendingComment: () => {},
    clearPendingComments: () => {},
    queueMessage: queueMessageFn,
    steerMessage: steerMessageFn,
    dequeueMessage: () => {},
    setComposerDraft: setComposerDraftFn,
    deleteContext: () => {},
  });
  const projects = () => ({
    activeProject: mockProject,
    projects: [mockProject, assistantProject],
    availableModes: [],
    agentStatus: mockCanSteer ? { capabilities: { modes: false }, capabilityDescriptor: { steer: { availability: 'native', confidence: 'native' } } } : null,
    refreshAgentStatus: () => {},
  });
  const panes = () => ({
    focusedPane: 'n1',
    openPanes: ['n1'],
    focusNonce: 0,
    paneItems: {},
    viewMode: 'single' as const,
  });
  return {
    ...actual,
    useChatStore: () => ({ ...projects(), ...panes(), ...actions() }),
    useChatActions: () => actions(),
    useOptionalChatActions: () => actions(),
    useChatProjects: () => projects(),
    useChatPanes: () => panes(),
    useStructuralSelector: (selector: (nodes: Record<string, ChatNodeState>) => unknown) =>
      selector({ n1: mockNode }),
    useChatNodesSnapshot: () => ({ n1: mockNode }),
    useChatNode: () => mockNode,
    chatLabel: () => '',
  };
});

vi.mock('../../state/prefs', async () => {
  const actual = await vi.importActual<any>('../../state/prefs');
  return {
    ...actual,
    usePrefs: () => ({
      prefs: {
        fontFamily: 'sans',
        showThoughts: false,
        terminalPalette: 'michi',
        terminalDensity: 'compact',
        paneRules: true,
        focusDim: 0,
        quoteMaxLines: 2,
      },
    }),
  };
});

// Stub heavy child components that reach into additional contexts.
vi.mock('../SelectionActions', () => ({
  default: ({ onQuote }: { onQuote: (quote: string) => void }) => (
    <button type="button" data-testid="quote-selection" onClick={() => onQuote('fresh quote')}>
      quote
    </button>
  ),
}));
vi.mock('../SlashPopup', () => ({ default: () => null }));
vi.mock('../AtMentionPopup', () => ({ default: () => null }));
vi.mock('../MentionEditor', () => ({
  default: React.forwardRef(function MentionEditorStub(props: any, ref: any) {
    React.useImperativeHandle(ref, () => ({ focus: () => {}, editor: null }));
    return (
      <>
        <textarea
          data-testid="composer-editor"
          value={props.value}
          onChange={(event) => props.onChange({
            value: event.target.value,
            mentions: mockEditorMentions,
          })}
        />
        <button
          type="button"
          data-testid="editor-submit"
          onClick={() => props.onSubmit?.({ branch: false })}
        >
          submit
        </button>
      </>
    );
  }),
}));
vi.mock('./PaneFind', () => ({ default: () => null }));
vi.mock('./PermissionBanner', () => ({ default: () => null }));
vi.mock('../ContextMenu', () => ({ default: () => null }));
vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

beforeEach(() => {
  createContextFn.mockReset();
  focusPaneFn.mockReset();
  setComposerDraftFn.mockReset();
  sendMessageFn.mockReset();
  queueMessageFn.mockReset();
  cancelStreamFn.mockReset();
  steerMessageFn.mockReset().mockResolvedValue(true);
  addPendingCommentFn.mockReset();
  importUploadFn.mockReset().mockRejectedValue(new Error('offline'));
  mockCanSteer = false;
  mockEditorMentions = [];
  mockNode.projectId = 'p1';
  mockNode.status = 'idle';
  delete mockNode.composerDraft;
  delete mockNode.pendingQueued;
  delete mockNode.pendingComments;
});

afterEach(() => {
  // Clean up any electron shim.
  delete (window as any).electron;
});

function dragEvent(type: string, files: File[]) {
  // jsdom doesn't implement DataTransfer, so we build a minimal stub.
  const fileList = Object.assign(files, {
    item: (i: number) => files[i] ?? null,
  });
  const items = files.map((f) => ({ kind: 'file', type: f.type, getAsFile: () => f }));
  const dt = {
    types: files.length > 0 ? ['Files'] : [],
    files: fileList,
    items,
    dropEffect: 'none' as string,
  };
  const ev = new Event(type, { bubbles: true, cancelable: true }) as any;
  ev.dataTransfer = dt;
  return ev;
}

describe('TPane drag-and-drop', () => {
  it('does NOT show overlay for non-file drags', () => {
    const { container } = render(<TPane nodeId="n1" />);
    const root = container.firstChild as HTMLElement;
    const ev = new Event('dragenter', { bubbles: true, cancelable: true }) as any;
    ev.dataTransfer = { types: ['text/plain'], items: [] };
    fireEvent(root, ev);
    expect(container.textContent).not.toMatch(/drop \d+ file/);
  });

  it('counter handles nested dragenter/leave without flicker', () => {
    const { container } = render(<TPane nodeId="n1" />);
    const root = container.firstChild as HTMLElement;
    fireEvent(root, dragEvent('dragenter', [new File(['x'], 'a.md')]));
    fireEvent(root, dragEvent('dragenter', [new File(['x'], 'a.md')]));  // nested
    fireEvent(root, dragEvent('dragleave', [new File(['x'], 'a.md')]));
    expect(container.textContent).toMatch(/drop \d+ file/);
    fireEvent(root, dragEvent('dragleave', [new File(['x'], 'a.md')]));
    expect(container.textContent).not.toMatch(/drop \d+ file/);
  });

  it('drop does NOT touch composer draft and does NOT fire success toast', async () => {
    (window as any).electron = {
      getPathForFile: (f: File) => `/abs/${f.name}`,
    };
    const { toast } = await import('sonner');
    const successSpy = vi.spyOn(toast, 'success').mockImplementation(() => '' as any);
    try {
      const { container } = render(<TPane nodeId="n1" />);
      const root = container.firstChild as HTMLElement;
      await act(async () => {
        fireEvent(root, dragEvent('drop', [new File(['x'], 'foo.md')]));
      });
      expect(successSpy).not.toHaveBeenCalled();
      expect(setComposerDraftFn).not.toHaveBeenCalled();
      expect(createContextFn).not.toHaveBeenCalled();
    } finally {
      successSpy.mockRestore();
      delete (window as any).electron;
    }
  });

  it('takes files the Dashboard forwards, and focuses itself', async () => {
    importUploadFn.mockResolvedValue({ name: 'a', filePath: '.attachments/a.md', displayName: 'a.md', size: 1 });
    render(<TPane nodeId="n1" />);
    let accepted = false;
    await act(async () => { accepted = await paneFileDropTarget('n1')!([new File(['x'], 'a.md')]); });
    expect(accepted).toBe(true);
    expect(focusPaneFn).toHaveBeenCalledWith('n1');
    expect(importUploadFn).toHaveBeenCalledWith('p1', '/tmp/p1', expect.any(File), expect.objectContaining({ subdir: '.attachments' }));
    expect(screen.getByTitle('/tmp/p1/.attachments/a.md').textContent).toContain('a.md');
  });

  it('declines forwarded files in the assistant\'s own workspace, which takes none', async () => {
    mockNode.projectId = 'ws-assistant';
    assistantProject.system = 'assistant';
    try {
      render(<TPane nodeId="n1" />);
      let accepted = true;
      await act(async () => { accepted = await paneFileDropTarget('n1')!([new File(['x'], 'a.md')]); });
      expect(accepted).toBe(false);
      expect(importUploadFn).not.toHaveBeenCalled();
    } finally {
      delete assistantProject.system;
    }
  });

  it('removes its web file picker when it unmounts', async () => {
    const view = render(<TPane nodeId="n1" />);
    await act(async () => { fireEvent.click(screen.getByTitle('Attach file')); });
    expect(document.querySelector('input[type="file"]')).not.toBeNull();
    view.unmount();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it('shows an embedded assistant\'s pending image from the assistant\'s workspace', async () => {
    mockNode.projectId = 'ws-assistant';
    importUploadFn.mockResolvedValue({ name: 'diagram', filePath: '.attachments/diagram.png', displayName: 'diagram.png', size: 1 });
    const { container } = render(<TPane nodeId="n1" embedded spacesAssistant />);
    await act(async () => {
      fireEvent(container.firstChild as HTMLElement, dragEvent('drop', [new File(['x'], 'diagram.png', { type: 'image/png' })]));
    });
    expect(importUploadFn).toHaveBeenCalledWith('ws-assistant', '/data/assistant/.michi', expect.any(File), expect.objectContaining({ subdir: '.attachments' }));
    expect(screen.getByRole('img', { name: 'diagram.png' }).getAttribute('src')).toContain('/files/ws-assistant/.attachments/diagram.png');
  });
});

describe('TPane composer draft freshness', () => {
  it('switches Stop to Send next before the draft store RAF while streaming', () => {
    mockNode.status = 'streaming';
    render(<TPane nodeId="n1" composerPreBlocks={hasText => !hasText && <span>Starter questions</span>} />);
    expect(screen.getByText('Starter questions')).toBeTruthy();

    fireEvent.change(screen.getByTestId('composer-editor'), {
      target: { value: 'queue this next' },
    });
    expect(screen.queryByText('Starter questions')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Send next|Stop stream/ }));

    expect(cancelStreamFn).not.toHaveBeenCalled();
    expect(queueMessageFn).toHaveBeenCalledWith(
      'n1',
      expect.objectContaining({ value: 'queue this next' }),
    );
  });

  it('submits same-tick text, mentions, and quote from the latest editor state', async () => {
    mockNode.composerDraft = { value: 'seed', mentions: [] };
    mockEditorMentions = [
      { start: 4, end: 11, kind: 'node', refId: 'n2', label: 'Thread' },
    ];
    render(<TPane nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('quote-selection'));
      fireEvent.change(screen.getByTestId('composer-editor'), {
        target: { value: 'ask @Thread' },
      });
      fireEvent.click(screen.getByTestId('editor-submit'));
    });

    expect(sendMessageFn).toHaveBeenCalledTimes(1);
    const [nodeId, wireText, meta] = sendMessageFn.mock.calls[0];
    expect(nodeId).toBe('n1');
    expect(wireText).toContain('fresh quote');
    expect(wireText).toContain('ask @node:n2');
    expect(meta).toMatchObject({
      quotedText: 'fresh quote',
      displayText: 'ask @node:n2',
    });
    expect(setComposerDraftFn).toHaveBeenLastCalledWith('n1', null);
  });

  it.each(['idle', 'streaming'] as const)('preserves a file quote while typing and %s submission', async (status) => {
    const quoteSource = { type: 'artifact' as const, filePath: '/doc.txt', snapshot: {
      hashKind: 'sha256-text-utf8' as const, contentHash: 'f'.repeat(64), backendConnectionId: 'local', projectId:'p1', treeId:'tr1', resolvedFilePath:'/doc.txt',
    } };
    mockNode.status = status;
    mockNode.composerDraft = { value:'', mentions:[], quotedText:'file selection', quoteSource };
    render(<TPane nodeId="n1" />);
    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-editor'), {target:{value:'review this'}});
      fireEvent.click(screen.getByTestId('editor-submit'));
    });
    if (status === 'streaming') {
      expect(queueMessageFn.mock.calls[0][1]).toMatchObject({quotedText:'file selection',quoteSource});
    } else {
      expect(sendMessageFn.mock.calls[0][1]).toContain('already-read version');
      expect(sendMessageFn.mock.calls[0][2]).toMatchObject({quoteSource,rejectedDraft:{quoteSource}});
    }
  });

  it('preserves queued file sources and comments in an accepted steer request', async () => {
    const quoteSource = { type: 'artifact' as const, filePath:'/doc.txt', snapshot: {
      hashKind:'sha256-text-utf8' as const, contentHash:'e'.repeat(64), backendConnectionId:'local', projectId:'p1', treeId:'tr1', resolvedFilePath:'/doc.txt',
    } };
    const comment = {id:'c1',quotedText:'selected',body:'fix',createdAt:1,source:quoteSource};
    mockNode.status = 'streaming'; mockCanSteer = true;
    mockNode.pendingQueued = [{id:'q1',value:'review',mentions:[],attachments:[],quotedText:'selected',quoteSource,comments:[comment],commentBlock:'comment context',queuedAt:1}];
    render(<TPane nodeId="n1" />);
    await act(async () => { fireEvent.click(screen.getByRole('button',{name:'Steer now'})); });
    expect(steerMessageFn.mock.calls[0][2].userMetadata).toMatchObject({quotedText:'selected',quoteSource,comments:[comment]});
    expect(steerMessageFn.mock.calls[0][1]).toContain('already-read version');
  });

  it('clears the file source when a new assistant selection replaces the quote', async () => {
    mockNode.composerDraft = {value:'',mentions:[],quotedText:'file selection',quoteSource:{type:'artifact',filePath:'/doc.txt'}};
    render(<TPane nodeId="n1" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('quote-selection'));
      fireEvent.change(screen.getByTestId('composer-editor'),{target:{value:'explain'}});
      fireEvent.click(screen.getByTestId('editor-submit'));
    });
    expect(sendMessageFn.mock.calls[0][2].quoteSource).toBeUndefined();
    expect(sendMessageFn.mock.calls[0][1]).toContain('previous assistant reply');
  });

  it.each([false,true])('restores dequeued comment context with structured metadata=%s', async (structured) => {
    const source = {type:'artifact' as const,filePath:'/doc.txt'};
    const comment = {id:'c1',quotedText:'selected',body:'fix',createdAt:1,source};
    mockNode.pendingQueued = [{id:'q1',value:'@Thread',mentions:[{start:0,end:7,kind:'node',refId:'n2',label:'Thread'}],attachments:[],commentBlock:'legacy file context',...(structured ? {comments:[comment]} : {}),queuedAt:1}];
    render(<TPane nodeId="n1" />);
    await act(async () => {fireEvent.click(screen.getByRole('button',{name:'Dequeue message'}));});
    const draft = setComposerDraftFn.mock.calls.at(-1)![1];
    if (structured) {
      expect(addPendingCommentFn).toHaveBeenCalledWith('n1','selected','fix',source);
      expect(draft.value).toBe('@Thread');
      expect(draft.mentions[0].start).toBe(0);
    } else {
      expect(draft.value).toBe('legacy file context\n\n@Thread');
      expect(draft.mentions[0].start).toBe('legacy file context\n\n'.length);
    }
  });

  it('keeps a dequeued attachment\'s workspace path when it is sent again', async () => {
    const shot = { name: 'shot.png', absPath: '/tmp/p1/.attachments/shot.png', relPath: '.attachments/shot.png' };
    mockNode.pendingQueued = [{ id: 'q1', value: 'look', mentions: [], attachments: [shot], queuedAt: 1 }];
    render(<TPane nodeId="n1" />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dequeue message' })); });
    delete mockNode.pendingQueued;
    await act(async () => { fireEvent.click(screen.getByTestId('editor-submit')); });
    expect(sendMessageFn.mock.calls[0][2].attachments).toEqual([shot]);
  });

  it('puts a dequeued message in front of what was typed since, keeping its quote and attachments', async () => {
    mockNode.status = 'streaming';
    mockNode.composerDraft = {
      value: 'B @Doc', mentions: [{ start: 2, end: 6, kind: 'context', refId: 'c1', label: 'Doc' }], quotedText: 'B quote',
    };
    mockNode.pendingQueued = [{
      id: 'q1', value: 'A @Thread', mentions: [{ start: 2, end: 9, kind: 'node', refId: 'n2', label: 'Thread' }],
      attachments: [{ name: 'a.txt', absPath: '/tmp/p1/.attachments/a.txt' }], queuedAt: 1,
    }];
    importUploadFn.mockResolvedValue({ filePath: '.attachments/b.txt', displayName: 'b.txt' });
    const { container } = render(<TPane nodeId="n1" />);
    await act(async () => {
      fireEvent(container.firstChild as HTMLElement, dragEvent('drop', [new File(['x'], 'b.txt')]));
    });
    expect([...container.querySelectorAll('.t-att-pending-file')].map((el) => el.getAttribute('title')))
      .toEqual(['/tmp/p1/.attachments/b.txt']);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dequeue message' })); });

    const draft = setComposerDraftFn.mock.calls.at(-1)![1];
    expect(draft.value).toBe('A @Thread\n\nB @Doc');
    expect(draft.mentions.map((m: MentionRecord) => draft.value.slice(m.start, m.end))).toEqual(['@Thread', '@Doc']);
    expect(draft.quotedText).toBe('B quote');
    expect([...container.querySelectorAll('.t-att-pending-file')].map((el) => el.getAttribute('title')))
      .toEqual(['/tmp/p1/.attachments/a.txt', '/tmp/p1/.attachments/b.txt']);
  });

  it('does not let an unrelated rerender roll back an uncommitted editor change', async () => {
    mockNode.composerDraft = { value: 'seed', mentions: [] };
    const view = render(<TPane nodeId="n1" />);

    await act(async () => {
      fireEvent.change(screen.getByTestId('composer-editor'), {
        target: { value: 'latest before rerender' },
      });
    });
    await act(async () => {
      view.rerender(<TPane nodeId="n1" contentMaxWidth={800} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-submit'));
    });

    expect(sendMessageFn).toHaveBeenCalledWith(
      'n1',
      'latest before rerender',
      expect.objectContaining({ displayText: 'latest before rerender' }),
    );
  });

  it('allows the same conversation to remain editable without a window owner', async () => {
    mockNode.composerDraft = { value: 'seed', mentions: [] };
    render(<TPane nodeId="n1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('editor-submit'));
    });

    expect(sendMessageFn).toHaveBeenCalledWith('n1', 'seed', expect.any(Object));
  });
});
