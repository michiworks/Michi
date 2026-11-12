import type React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRunPaneId } from '../../../state/paneItems';
import { registerPaneFileDropTarget } from '../paneFileDropTargets';

const mocks = vi.hoisted(() => ({
  focusedPane: '' as string,
  importWorkspaceFileUpload: vi.fn(),
  toastError: vi.fn(),
}));

const runPaneId = agentRunPaneId('backend-a', 'run-1');
// Stable across renders, like the store's own values.
const store = vi.hoisted(() => ({
  projects: { activeProject: { id: 'workspace-1', cwd: '/w', activeTreeId: 'tree-1' }, agentStatus: { customAgentsEnabled: true } },
  actions: { closePane: () => {}, setPaneWidth: () => {}, openAgentRunPane: () => {} },
  panes: new Map<string, unknown>(),
}));
const openPanes = [runPaneId, 'chat-1', 'chat-2'];
const paneItems = {
  [runPaneId]: {
    id: runPaneId, kind: 'agent-run' as const, projectId: 'workspace-1', treeId: null,
    title: 'Reviewer', createdAt: 1, backendConnectionId: 'backend-a', runId: 'run-1',
  },
};
const panesFor = (focusedPane: string) => {
  if (!store.panes.has(focusedPane)) store.panes.set(focusedPane, { openPanes, focusedPane, paneItems });
  return store.panes.get(focusedPane);
};
const noNodes = {};

vi.mock('../../../state/chatStore', () => ({
  useChatProjects: () => store.projects,
  useChatPanes: () => panesFor(mocks.focusedPane),
  useChatActions: () => store.actions,
  useStructuralSelector: (selector: (nodes: Record<string, never>) => unknown) => selector(noNodes),
  shallowArrayEqual: <T,>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((value, index) => Object.is(value, b[index])),
}));
const agentDomain = vi.hoisted(() => ({
  state: { runs: {}, eventsByRun: {}, interactionsByRun: {} },
  loadRuns: async () => undefined, subscribeWorkspace: () => () => {},
  dispatch: () => {}, sendInput: async () => undefined, cancel: async () => undefined,
}));
vi.mock('../../../state/agentDomain', () => ({ useAgentDomain: () => agentDomain }));
const prefs = vi.hoisted(() => ({ prefs: { singlePaneContentWidth: null, defaultPaneWidth: 480 } }));
vi.mock('../../../state/prefs', () => ({ usePrefs: () => prefs }));
vi.mock('../../../services/api', () => ({
  getAgentRunDetail: vi.fn(() => new Promise(() => undefined)),
  getWebUploadCwd: vi.fn(async () => '/uploads'),
  importWorkspaceFileUpload: mocks.importWorkspaceFileUpload,
  respondAgentRunInteraction: vi.fn(),
}));
vi.mock('../../../services/attention/policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/attention/policy')>(),
  presentAttention: vi.fn(),
}));
// Electron with a local workspace: the old drop attached this raw path uncopied.
vi.mock('../../../lib/electronBridge', () => ({ getElectron: () => ({ getPathForFile: (f: File) => `/Users/me/Desktop/${f.name}` }) }));
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }));
vi.mock('../TPane', () => ({ default: ({ nodeId }: { nodeId: string }) => <div className="terminal-pane">chat {nodeId}</div> }));
vi.mock('../assistant/AssistantLinks', () => ({ AssistantPaneScope: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../../ResizeHandle', () => ({ default: () => null }));

import TerminalDashboard from './Dashboard';

const runPaneSurface = (container: HTMLElement) =>
  container.querySelector(`[data-node-id="${runPaneId}"] .pane-entry-surface`)!;

function drop(target: Element, files: File[]) {
  const ev = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  ev.dataTransfer = { types: ['Files'], files, items: files.map((f) => ({ kind: 'file', type: f.type })) };
  fireEvent(target, ev);
}

describe('Dashboard file drops', () => {
  const unregister: Array<() => void> = [];
  const target = (nodeId: string, accepts = true) => {
    const fn = vi.fn(async () => accepts);
    unregister.push(registerPaneFileDropTarget(nodeId, fn));
    return fn;
  };

  beforeEach(() => {
    mocks.focusedPane = 'chat-1';
    mocks.importWorkspaceFileUpload.mockReset();
    mocks.toastError.mockReset();
    HTMLElement.prototype.scrollTo = vi.fn();
  });
  afterEach(() => {
    unregister.splice(0).forEach((fn) => fn());
  });

  it('hands files dropped outside a chat to the focused chat pane, not their raw paths', async () => {
    const chat1 = target('chat-1');
    const { container } = render(<TerminalDashboard />);
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    await act(async () => { drop(runPaneSurface(container), [shot]); });
    expect(chat1).toHaveBeenCalledWith([shot]);
    expect(mocks.importWorkspaceFileUpload).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('prefers the chat pane under the cursor to the focused one', async () => {
    const chat1 = target('chat-1');
    const chat2 = target('chat-2');
    const { container } = render(<TerminalDashboard />);
    await act(async () => { drop(container.querySelector('[data-node-id="chat-2"]')!, [new File(['x'], 'a.md')]); });
    expect(chat2).toHaveBeenCalledOnce();
    expect(chat1).not.toHaveBeenCalled();
  });

  it('uploads nothing and says so when no chat pane takes the files', async () => {
    mocks.focusedPane = runPaneId;
    const { container } = render(<TerminalDashboard />);
    await act(async () => { drop(runPaneSurface(container), [new File(['x'], 'a.md')]); });
    expect(mocks.importWorkspaceFileUpload).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('Drop files on a chat pane to attach them');
  });

  it('says so when the chat pane declines them (the assistant takes no files)', async () => {
    const assistant = target('chat-1', false);
    const { container } = render(<TerminalDashboard />);
    await act(async () => { drop(runPaneSurface(container), [new File(['x'], 'a.md')]); });
    expect(assistant).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledWith('Drop files on a chat pane to attach them');
  });

  it('leaves a drop inside a chat pane to the pane', async () => {
    const chat1 = target('chat-1');
    render(<TerminalDashboard />);
    await act(async () => { drop(screen.getByText('chat chat-1'), [new File(['x'], 'a.md')]); });
    expect(chat1).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
