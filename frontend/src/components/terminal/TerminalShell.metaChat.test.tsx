import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { getSourceNavState, resetSourceNavForTests } from '../../state/sourceNav/sourceNav';

// DESIGN-v2 §1: Pages has no Meta agent window of its own any more. The one
// panel is W2-F1a's; a fake stands in for its API and host.
const panelFake = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const fake = {
    open: false,
    toggles: [] as string[],
    sources: new Map<string, (target: { kind: string; id: string; messageId?: string }) => boolean>(),
    notify: () => { for (const listener of [...listeners]) listener(); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reset: () => { fake.open = false; fake.toggles = []; fake.sources.clear(); },
  };
  return fake;
});
vi.mock('../../state/companion/companionPanel', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../state/companion/companionPanel');
  return {
    ...actual,
    toggleCompanionPanel: (tab: string) => { panelFake.toggles.push(tab); panelFake.open = !panelFake.open; panelFake.notify(); },
    closeCompanionPanel: () => { panelFake.open = false; panelFake.notify(); },
    registerCompanionOpenSource: (area: string, open: (target: { kind: string; id: string; messageId?: string }) => boolean) => {
      panelFake.sources.set(area, open);
      return () => { if (panelFake.sources.get(area) === open) panelFake.sources.delete(area); };
    },
  };
});
vi.mock('./companion/CompanionPanel', () => ({
  CompanionPanelHost: function FakePanelHost() {
    const open = React.useSyncExternalStore(panelFake.subscribe, () => panelFake.open);
    return open ? <aside aria-label="Michi" data-assistant-panel="" data-companion-panel="" /> : null;
  },
}));
vi.mock('../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../services/api')>('../../services/api');
  return { ...actual, fetchPrefs: vi.fn().mockResolvedValue(null) };
});
vi.mock('../../services/api/assistant', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/assistant')>('../../services/api/assistant');
  return { ...actual, fetchAssistant: () => new Promise(() => {}) };
});
vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home</div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./spaces/SpaceView', () => ({ default: () => <div>Space view</div> }));
vi.mock('./scheduled/useScheduledJobs', () => ({ useScheduledJobs: () => ({ jobs: [], loading: false, unavailable: false }) }));
vi.mock('../../state/pages/useSpaces', () => ({ useSpaces: () => ({ spaces: [], status: 'ready', error: null, refresh: vi.fn() }) }));
vi.mock('../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({
      activeProject: null, activeProjectId: null, projects: [], order: [], edges: [], theme: 'light', availableModes: [],
      agentStatus: null, warmFailedError: null, focusedNodeId: null, selection: new Set<string>(), hydrated: true,
      treeSelection: new Set<string>(), searchHighlightTerm: null,
    }),
    useChatPanes: () => ({ openPanes: [], focusedPane: null, focusNonce: 0, paneItems: {}, viewMode: 'single' as const }),
    useChatActions: () => ({
      createProject: vi.fn(), enterChatsWorkspace: () => Promise.resolve('chats-default'), focusPane: () => {}, closePane: () => {},
      openPane: () => {}, createBlankChild: vi.fn(), restoreLastDeletion: vi.fn(), clearSelection: () => {}, clearTreeSelection: () => {},
      selectAllTrees: () => {}, selectProject: () => {},
    }),
    useStructuralSelector: (s: (n: Record<string, unknown>) => unknown) => s({}),
    useChatNodesSnapshot: () => ({}),
    useNodesSelector: (s: (n: Record<string, unknown>) => unknown) => s({}),
    useChatNodeReader: () => () => undefined,
    useChatNode: () => null,
    chatLabel: () => '',
  };
});

const rail = (name: string) => screen.getByRole('navigation', { name: 'Areas' }).querySelector<HTMLButtonElement>(`[data-area="${name}"]`)!;
const pressCmdJ = () => fireEvent.keyDown(window, { key: 'j', metaKey: true });

describe('TerminalShell in Pages (DESIGN-v2 §1)', () => {
  beforeEach(() => {
    panelFake.reset();
    resetSourceNavForTests();
    sessionStorage.clear();
    localStorage.clear();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
  });
  afterEach(cleanup);

  it('has no Meta agent window, sidebar Assistant row or topbar Assistant toggle', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('spaces'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(document.querySelector('.meta-chat-panel')).toBeNull();
    expect(screen.queryByText('Assistant', { selector: '.area-side__label' })).toBeNull();
    expect(document.querySelector('button.t-icon-btn[aria-label="Assistant"]')).toBeNull();
  });

  it('routes ⌘J to the one panel in Pages as everywhere else, once per press', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('spaces'));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    pressCmdJ();
    expect(panelFake.toggles).toEqual(['chat']);
    expect(screen.getByRole('complementary', { name: 'Michi' })).toBeTruthy();

    fireEvent.click(rail('conversations'));
    await screen.findByText('Conversation home');
    // The panel is shell-level: it stays open across areas.
    expect(screen.getByRole('complementary', { name: 'Michi' })).toBeTruthy();
    pressCmdJ();
    expect(panelFake.toggles).toEqual(['chat', 'chat']);
  });

  it('opens a conversation link from the panel as a source popover while Pages is on screen', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    expect(panelFake.sources.has('spaces')).toBe(false);
    fireEvent.click(rail('spaces'));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const open = panelFake.sources.get('spaces');
    expect(open).toBeTypeOf('function');
    let opened = false;
    act(() => { opened = open!({ kind: 'node', id: 'n-src', messageId: 'm-1' }); });
    expect(opened).toBe(true);
    expect(getSourceNavState().popover?.target).toEqual({ backendConnectionId: 'local', nodeId: 'n-src', messageId: 'm-1' });
    // Page links keep their usual behaviour.
    expect(open!({ kind: 'page', id: 'p1' })).toBe(false);

    // Elsewhere the link opens the conversation as before: nothing is registered.
    fireEvent.click(rail('conversations'));
    await screen.findByText('Conversation home');
    expect(panelFake.sources.has('spaces')).toBe(false);
  });

  it('reads Spaces › Home in the topbar on the Spaces Home', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('spaces'));
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const crumb = document.querySelector<HTMLElement>('.terminal-topbar-breadcrumb')!;
    expect(crumb.textContent).toBe('PAGES›Home');
  });
});
