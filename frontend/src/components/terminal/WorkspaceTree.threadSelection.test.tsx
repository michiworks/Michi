/**
 * Clicks on a Structure thread row: ⌘ toggles the thread in the selection,
 * ⇧ adds the rows from the anchor through it, and a plain click opens it
 * with the shared expand rule.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WorkspaceTree from './WorkspaceTree';
import { ChatProvider, useChatStore } from '../../state/chatStore';
import { PrefsProvider } from '../../state/prefs';
import type { ChatNodeState, Project } from '../../state/chatTypes';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    listAgentModes: vi.fn().mockResolvedValue({ availableModes: [], defaultModeId: null }),
    fetchAllWorkspacesMeta: vi.fn().mockResolvedValue([]),
    fetchTreeMessages: vi.fn().mockResolvedValue([]),
    fetchWorkspaces: vi.fn().mockResolvedValue([]),
    fetchWorkspace: vi.fn().mockResolvedValue(null),
    warmCwd: vi.fn().mockResolvedValue(undefined),
  };
});

if (typeof (globalThis as { CSS?: unknown }).CSS === 'undefined') {
  (globalThis as { CSS?: unknown }).CSS = { escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
});

const chat = (nodeId: string, title: string, parentNodeId?: string): ChatNodeState => ({
  nodeId, chatId: null, projectId: 'p1', kind: 'chat', title, messages: [], followUps: [], status: 'idle',
  ...(parentNodeId ? { parentNodeId } : {}),
});

/** Seven threads, newest first; Thread 1 has a branch. The sidebar shows five
 *  (its default cap) and appends the active Thread 7, so Thread 6 is hidden. */
function seed() {
  const nodes: Record<string, ChatNodeState> = { b1: chat('b1', 'Branch of 1', 'r1') };
  const trees: Project['trees'] = [];
  for (let n = 1; n <= 7; n++) {
    nodes[`r${n}`] = chat(`r${n}`, `Thread ${n}`);
    trees.push({ id: `t${n}`, rootNodeId: `r${n}`, createdAt: 0, lastActiveAt: 100 - n });
  }
  const projects: Project[] = [{
    id: 'p1', name: 'Workspace', cwd: '~/x', createdAt: 0,
    chatIds: Object.keys(nodes), edges: [{ source: 'r1', target: 'b1', kind: 'branch' }],
    trees, activeTreeId: 't7',
  }];
  localStorage.setItem('michi:v1:state', JSON.stringify({ version: 2, projects, nodes, activeProjectId: 'p1' }));
  localStorage.setItem('michi:migrated', '1');
}

const storeRef: { current: ReturnType<typeof useChatStore> | null } = { current: null };
function StoreProbe() {
  storeRef.current = useChatStore();
  return null;
}

async function renderTree() {
  seed();
  render(
    <PrefsProvider>
      <ChatProvider>
        <StoreProbe />
        <WorkspaceTree />
      </ChatProvider>
    </PrefsProvider>,
  );
  await screen.findByText('Thread 7');
}

const thread = (n: number) => screen.getByText(`Thread ${n}`);
const selected = () => [...storeRef.current!.treeSelection].sort();
const activeTree = () => storeRef.current!.projects[0].activeTreeId;

describe('Structure thread row clicks', () => {
  it('⌘-click toggles a thread in and out of the selection without opening it', async () => {
    await renderTree();
    fireEvent.click(thread(2), { metaKey: true });
    fireEvent.click(thread(3), { metaKey: true });
    await waitFor(() => expect(selected()).toEqual(['t2', 't3']));
    fireEvent.click(thread(2), { metaKey: true });
    await waitFor(() => expect(selected()).toEqual(['t3']));
    expect(activeTree()).toBe('t7');
  });

  it('⇧-click adds the threads from the anchor through the clicked one', async () => {
    await renderTree();
    fireEvent.click(thread(2), { metaKey: true });
    fireEvent.click(thread(4), { shiftKey: true });
    await waitFor(() => expect(selected()).toEqual(['t2', 't3', 't4']));
  });

  it('⇧-click takes only the rows the sidebar shows, not a thread past its cap', async () => {
    await renderTree();
    expect(screen.queryByText('Thread 6')).toBeNull();
    fireEvent.click(thread(4), { metaKey: true });
    fireEvent.click(thread(7), { shiftKey: true });
    await waitFor(() => expect(selected()).toEqual(['t4', 't5', 't7']));
  });

  it('a plain click opens the thread: a collapsed one expands, the open active one collapses, an open inactive one stays open', async () => {
    await renderTree();
    expect(screen.queryByText('Branch of 1')).toBeNull();
    fireEvent.click(thread(1));
    await waitFor(() => expect(activeTree()).toBe('t1'));
    expect(await screen.findByText('Branch of 1')).toBeTruthy();

    fireEvent.click(thread(1));
    await waitFor(() => expect(screen.queryByText('Branch of 1')).toBeNull());

    fireEvent.click(thread(1));
    expect(await screen.findByText('Branch of 1')).toBeTruthy();
    fireEvent.click(thread(2));
    await waitFor(() => expect(activeTree()).toBe('t2'));
    fireEvent.click(thread(1));
    await waitFor(() => expect(activeTree()).toBe('t1'));
    expect(screen.getByText('Branch of 1')).toBeTruthy();
  });
});
