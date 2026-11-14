/**
 * A temporary chat's sidebar row: a ghost before its title, and its name says
 * so. A regular chat's row has neither.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThreadRow from './ThreadRow';
import type { ChatNodeState } from '../../state/chatTypes';

const H = vi.hoisted(() => ({ node: null as ChatNodeState | null, sidebarRowStyle: 'classic' }));

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { showSidebarTimestamps: false, sidebarRowStyle: H.sidebarRowStyle } }),
}));
vi.mock('../../state/chatStore', () => ({
  useChatNode: () => H.node,
  useChatActions: () => ({ clearTreeSelection: vi.fn() }),
  useChatProjects: () => ({ projects: [], openPanes: [], focusedPane: null, treeSelection: new Set<string>(), focusedNodeId: null }),
  useStructuralSelector: (selector: (nodes: Record<string, unknown>) => unknown) => selector({}),
}));

function node(patch: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId: 'n1', kind: 'chat', chatId: 'n1', projectId: 'p1', title: 'Compare two job offers', messages: [], followUps: [], status: 'idle', ...patch } as ChatNodeState;
}

function row() {
  const noop = vi.fn();
  return render(
    <ThreadRow tree={{ id: 't1', rootNodeId: 'n1', createdAt: 0, lastActiveAt: 1 }} projectId="p1" isActive={false}
      hasBranches={false} expanded={false} onActivate={noop} onToggleExpand={noop}
      actions={{ activateTree: noop, archiveTree: noop, unarchiveTree: noop, pinTree: noop, unpinTree: noop, renameTree: noop, deleteTree: noop }} />,
  );
}

beforeEach(() => { H.sidebarRowStyle = 'classic'; });

describe('a temporary chat’s sidebar row', () => {
  it.each(['classic', 'rounded-inset'])('puts a ghost before the title (row style %s), and names the row a temporary chat', (style) => {
    H.sidebarRowStyle = style;
    H.node = node({ temporary: true });
    const { container } = row();
    const mark = container.querySelector('[data-temporary-chat-mark]');
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    // Before the title, not after it as the pin is.
    const title = screen.getByText('Compare two job offers');
    expect(mark!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Compare two job offers, temporary chat' })).toBeTruthy();
  });

  it('marks nothing on a regular chat’s row', () => {
    H.node = node();
    const { container } = row();
    expect(container.querySelector('[data-temporary-chat-mark]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Compare two job offers' })).toBeTruthy();
  });
});
