import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { backTarget } from '../../lib/backStack';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { closeCompanionPanel, openCompanionPanel, resetCompanionPanelForTests } from '../../state/companion/companionPanel';
import { isDashboardUncovered } from '../../state/panePresenceVisibility';

const topbar = vi.hoisted(() => ({ rail: [] as Array<boolean | undefined>, phoneBack: undefined as (() => void) | undefined }));

vi.mock('./Topbar', () => ({
  default: ({ sidebarRail, onToggleSidebar, onNewThread, phoneBack }: { sidebarRail?: boolean; onToggleSidebar: () => void; onNewThread?: () => void; phoneBack?: () => void }) => {
    topbar.rail.push(sidebarRail);
    topbar.phoneBack = phoneBack;
    return <>
      <button type="button" data-sidebar-rail={String(!!sidebarRail)} onClick={onToggleSidebar}>toggle sidebar</button>
      <button type="button" onClick={onNewThread}>new chat</button>
    </>;
  },
}));
vi.mock('./companion/CompanionPanel', async () => {
  const { useCompanionPanel } = await vi.importActual<typeof import('../../state/companion/companionPanel')>('../../state/companion/companionPanel');
  return {
    CompanionPanelHost: ({ covered, onShownChange }: { covered?: boolean; onShownChange?: (shown: boolean) => void }) => {
      const { open } = useCompanionPanel();
      // On screen whenever it is open, reported as the real host reports it.
      React.useLayoutEffect(() => {
        if (!open) return undefined;
        onShownChange?.(true);
        return () => onShownChange?.(false);
      }, [open, onShownChange]);
      return open ? <aside aria-label="Michi panel" data-companion-panel="" tabIndex={-1} data-covered={String(!!covered)} /> : null;
    },
  };
});
vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home<button type="button">Home action</button></div> }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./pages/Scheduled', async () => {
  const nav = await vi.importActual<typeof import('./scheduled/scheduledNav')>('./scheduled/scheduledNav');
  return { default: () => (nav.useScheduledRoute().kind === 'job' ? <div>Job detail page</div> : <div>Scheduled page</div>) };
});
vi.mock('./pages/settings/AppearancePane', () => ({ AppearancePane: () => <div>Appearance pane</div> }));
vi.mock('./pages/settings/ModelPane', () => ({ ModelPane: () => <div>Model pane</div> }));
vi.mock('./scheduled/useScheduledJobs', () => ({ useScheduledJobs: () => ({ jobs: [{ id: 'job-1', name: 'Digest', workspaceId: 'w1', activeRunId: null, schedule: { kind: 'every', everySeconds: 3600 } }], loading: false, unavailable: false }) }));
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

const wideWidth = window.innerWidth;
const areas = () => screen.queryByRole('navigation', { name: 'Areas' });
const rail = (name: string) => screen.getByRole('navigation', { name: 'Areas' }).querySelector<HTMLButtonElement>(`[data-area="${name}"]`)!;
const toggle = () => screen.getByRole('button', { name: 'toggle sidebar' });
const panel = () => screen.queryByRole('complementary', { name: 'Michi panel' });

describe('TerminalShell in a narrow window', () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetCompanionPanelForTests();
    topbar.rail = [];
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false }));
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  });
  afterEach(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: wideWidth }); });

  // With no workspace yet, the first load opens New workspace; Back closes it.
  const closeFirstLoadDialog = async () => {
    await screen.findByRole('dialog');
    act(() => backTarget()?.back());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  };

  it('opens its drawer with a back swipe from the left edge at a root, and Back closes it', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    const home = await screen.findByText('Conversation home');
    await closeFirstLoadDialog();
    fireEvent.touchStart(home, { touches: [{ identifier: 1, clientX: 6, clientY: 300 }] });
    fireEvent.touchMove(home, { touches: [{ identifier: 1, clientX: 40, clientY: 300 }] });
    expect(areas()).toBeTruthy();
    fireEvent.touchMove(home, { touches: [{ identifier: 1, clientX: 260, clientY: 300 }] });
    fireEvent.touchEnd(home, { touches: [] });
    expect(areas()).toBeTruthy();
    act(() => backTarget()?.back());
    await waitFor(() => expect(areas()).toBeNull());
  });

  it('lands a released swipe at once under Reduce motion', async () => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    const home = await screen.findByText('Conversation home');
    await closeFirstLoadDialog();
    fireEvent.touchStart(home, { touches: [{ identifier: 1, clientX: 6, clientY: 300 }] });
    fireEvent.touchMove(home, { touches: [{ identifier: 1, clientX: 40, clientY: 300 }] });
    expect(areas()).toBeTruthy();
    fireEvent.touchEnd(home, { touches: [] });
    expect(areas()).toBeNull();
  });

  it('goes Back to the page a page opened, but starts afresh from a drawer choice', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    await screen.findByText('Conversation home');
    await closeFirstLoadDialog();
    expect(topbar.phoneBack).toBeUndefined();
    act(() => { window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'scheduled' } })); });
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    expect(topbar.phoneBack).toBeTypeOf('function');
    act(() => backTarget()?.back());
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    expect(topbar.phoneBack).toBeUndefined();

    // Picked with the drawer open: a root, with nothing to go back to.
    fireEvent.click(toggle());
    act(() => { window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'scheduled' } })); });
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    fireEvent.click(toggle());
    await waitFor(() => expect(areas()).toBeNull());
    expect(topbar.phoneBack).toBeUndefined();
    expect(backTarget()).toBeNull();
  });

  it('has no area rail; its drawer opens with the areas as the first row', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    expect(areas()).toBeNull();
    expect(toggle().getAttribute('data-sidebar-rail')).toBe('false');

    fireEvent.click(toggle());
    expect(rail('conversations').getAttribute('aria-current')).toBe('page');
    expect(toggle().getAttribute('data-sidebar-rail')).toBe('false');
    fireEvent.click(toggle());
    expect(areas()).toBeNull();
  });

  it('opens Settings from the drawer, which closes, and keeps its categories in the Settings drawer', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(toggle());
    fireEvent.click(rail('settings'));
    expect(await screen.findByText('Appearance pane')).toBeTruthy();
    expect(areas()).toBeNull();
    const sections = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(screen.getByRole('button', { name: 'Runtime & model' }));
    expect(await screen.findByText('Model pane')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBe(sections);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(toggle().getAttribute('data-sidebar-rail')).toBe('false');
  });

  it('returns from Settings with a Back button in the top-left corner instead of ×', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(toggle());
    fireEvent.click(rail('settings'));
    expect(await screen.findByText('Appearance pane')).toBeTruthy();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    const back = within(dialog).getByRole('button', { name: 'Back' });
    expect(dialog.querySelector('.ui-overlay-header')!.firstElementChild).toBe(back);
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    expect(screen.getByText('Conversation home')).toBeTruthy();
  });

  it('steps Back from a Settings section to the section list before closing, and reopens on the list', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(toggle());
    fireEvent.click(rail('settings'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    const level = () => dialog.querySelector('.terminal-settings--drawer')?.getAttribute('data-view');
    await waitFor(() => expect(level()).toBe('menu'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Runtime & model' }));
    expect(await screen.findByText('Model pane')).toBeTruthy();
    expect(level()).toBe('section');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    expect(level()).toBe('menu');
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBe(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull());
    fireEvent.click(toggle());
    fireEvent.click(rail('settings'));
    const reopened = await screen.findByRole('dialog', { name: 'Settings' });
    await waitFor(() => expect(reopened.querySelector('.terminal-settings--drawer')?.getAttribute('data-view')).toBe('menu'));
  });

  it('keeps the drawer open on the Scheduled list and closes it when a job is picked', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(toggle());
    fireEvent.click(rail('scheduled'));
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    expect(rail('scheduled').getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: 'Digest' }));
    expect(await screen.findByText('Job detail page')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Digest' })).toBeNull());
  });

  // The Michi panel lies over the page here, so what opens a page closes it.
  it('closes the panel over the page for the topbar + and Home', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    await screen.findByText('Conversation home');
    act(() => openCompanionPanel());
    expect(panel()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'new chat' }));
    expect(panel()).toBeNull();

    act(() => openCompanionPanel());
    act(() => { window.dispatchEvent(new CustomEvent('michi:goto-home')); });
    expect(panel()).toBeNull();
  });

  it('makes the page under the panel inert while it shows, and hands focus back to it once it is live again', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    const action = await screen.findByRole('button', { name: 'Home action' });
    await closeFirstLoadDialog();
    const page = action.closest('.terminal-content-col')!;
    act(() => action.focus());
    act(() => openCompanionPanel());
    expect(page.hasAttribute('inert')).toBe(true);
    act(() => panel()!.focus());
    act(() => closeCompanionPanel());
    expect(page.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(action);
  });

  it('holds the focus in the drawer over an inert page, and hands it back to ≡ when dismissed', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    const action = await screen.findByRole('button', { name: 'Home action' });
    await closeFirstLoadDialog();
    const page = action.closest('.terminal-content-col')!;
    act(() => toggle().focus());
    fireEvent.click(toggle());
    const drawer = document.querySelector('aside.terminal-sidebar')!;
    expect(document.activeElement).toBe(drawer);
    expect(page.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(drawer.contains(document.activeElement) && document.activeElement !== drawer).toBe(true);
    act(() => backTarget()?.back());
    expect(document.activeElement).toBe(toggle());
    expect(page.hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(areas()).toBeNull());
  });

  it('says the Dashboard is covered while the panel or the drawer lies over it', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    await screen.findByText('Conversation home');
    await closeFirstLoadDialog();
    expect(isDashboardUncovered(), 'Home is up').toBe(false);
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(await screen.findByText('Conversation dashboard')).toBeTruthy();
    expect(isDashboardUncovered()).toBe(true);
    act(() => openCompanionPanel());
    expect(isDashboardUncovered(), 'under the Michi panel').toBe(false);
    act(() => closeCompanionPanel());
    expect(isDashboardUncovered()).toBe(true);
    fireEvent.click(toggle());
    expect(areas()).toBeTruthy();
    expect(isDashboardUncovered(), 'under the drawer').toBe(false);
    act(() => backTarget()?.back());
    await waitFor(() => expect(areas()).toBeNull());
    expect(isDashboardUncovered()).toBe(true);
  });

  it('opens the drawer over the panel, which a dismissal keeps and a choice in the drawer closes', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    await screen.findByText('Conversation home');
    act(() => openCompanionPanel());
    fireEvent.click(toggle());
    expect(areas()).toBeTruthy();
    expect(panel()?.getAttribute('data-covered')).toBe('true');
    fireEvent.click(toggle());
    await waitFor(() => expect(areas()).toBeNull());
    expect(panel()?.getAttribute('data-covered')).toBe('false');

    // An area swaps the page under the panel.
    fireEvent.click(toggle());
    fireEvent.click(rail('scheduled'));
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    expect(panel()).toBeNull();
    expect(areas()).toBeTruthy();

    // A row that opens something in the main column: a scheduled job.
    act(() => openCompanionPanel());
    fireEvent.click(screen.getByRole('button', { name: 'Digest' }));
    expect(await screen.findByText('Job detail page')).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it('leaves the Dashboard uncovered beside the docked panel when the window is wide', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    await screen.findByText('Conversation home');
    await closeFirstLoadDialog();
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(await screen.findByText('Conversation dashboard')).toBeTruthy();
    act(() => openCompanionPanel());
    expect(panel()).toBeTruthy();
    expect(isDashboardUncovered()).toBe(true);
  });

  it('keeps the overlay open when the window is wide, where there is none', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('settings'));
    expect(await screen.findByText('Appearance pane')).toBeTruthy();
    expect(toggle().getAttribute('data-sidebar-rail')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Runtime & model' }));
    expect(await screen.findByText('Model pane')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
    const dialog = screen.getByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Back' })).toBeNull();
  });
});
