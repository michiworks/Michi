import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from './CommandPalette';

const store = vi.hoisted(() => ({ activeProject: null as null | { id: string; name: string; trees: never[]; activeTreeId: null; chatIds: never[] } }));
vi.mock('../../state/chatStore', () => ({
  useChatStore: () => ({ activeProject: store.activeProject, projects: store.activeProject ? [store.activeProject] : [], selection: new Set(), clearSelection: vi.fn(), openPane: vi.fn(), openPaneInTree: vi.fn(), createDigest: vi.fn(), createMergedChat: vi.fn(), createThread: vi.fn(), activateTree: vi.fn(), archiveTree: vi.fn(), unarchiveTree: vi.fn(), selectProject: vi.fn(), setFocusedNodeId: vi.fn(), setSearchHighlightTerm: vi.fn(), agentStatus: { customAgentsEnabled: true } }),
  useChatNodesSnapshot: () => ({}),
  selectAllChats: () => [],
}));
vi.mock('../../state/prefs', () => ({ usePrefs: () => ({ prefs: { bypassPermissions: false }, setPref: vi.fn() }) }));
vi.mock('../../lib/digestPrompt', () => ({ requestDigest: vi.fn() }));

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  store.activeProject = null;
});

const rows = () => [...document.querySelectorAll<HTMLElement>('.ui-menu-item')];
const label = (row: HTMLElement | undefined) => row?.querySelector('.michi-menu-label')?.textContent ?? null;
const activeLabel = () => label(rows().find((row) => row.dataset.active === 'true'));

describe('CommandPalette Agent navigation', () => {
  it('finds Agent navigation by search and keeps existing empty-query number behavior', () => {
    const setPage = vi.fn(); const onClose = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={setPage} onClose={onClose} />);
    const input = screen.getByPlaceholderText('Search chats, commands, messages…');
    fireEvent.keyDown(input, { key: '1', metaKey: true });
    expect(setPage).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Agent Library' } });
    fireEvent.keyDown(input, { key: '1', metaKey: true });
    expect(setPage).toHaveBeenCalledWith('agents');
    expect(onClose).toHaveBeenCalled();
  });

  it('moves the highlight, numbers rows and runs them in the order they show, sections and all', () => {
    store.activeProject = { id: 'workspace-1', name: 'Workspace A', trees: [], activeTreeId: null, chatIds: [] };
    const setPage = vi.fn();
    render(<CommandPalette activePage="dashboard" setPage={setPage} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText('Search chats, commands, messages…');
    const shown = rows().map(label);
    expect(shown[0]).toBe('Go to home');
    const opening = shown.indexOf('Open Agent Library');
    expect(shown[opening + 1]).toBe('Ask Michi');
    // The row an empty palette highlights stays as it was.
    expect(activeLabel()).toBe('Open Agent Library');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeLabel()).toBe('Ask Michi');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeLabel()).toBe(shown[opening + 2]);

    fireEvent.change(input, { target: { value: 'o' } });
    const filtered = rows();
    expect(filtered[0].dataset.active).toBe('true');
    expect(filtered[0].querySelector('.michi-menu-keys')?.textContent).toMatch(/1$/);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeLabel()).toBe(label(filtered[1]));
    fireEvent.keyDown(input, { key: '1', metaKey: true });
    expect(setPage).toHaveBeenCalledWith('home');
  });
});
