import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { OPEN_NATIVE_PAGE_EVENT } from './spaces/SpacesPage';
import { OPEN_SETTINGS_SECTION_EVENT } from './scheduled/metaAgent/metaAgentNav';
import { openScheduledHome } from './scheduled/scheduledNav';

vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home</div> }));
// With no workspace the shell offers New workspace on load; its modal would hold the shortcuts these tests press.
vi.mock('../NewWorkspaceDialog', () => ({ default: () => null }));
vi.mock('./NewWorkspaceAutoOpen', () => ({ NewWorkspaceAutoOpen: () => null }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./pages/Scheduled', async () => {
  const nav = await vi.importActual<typeof import('./scheduled/scheduledNav')>('./scheduled/scheduledNav');
  return { default: () => (nav.useScheduledRoute().kind === 'job' ? <div>Job detail page</div> : <div>Scheduled page</div>) };
});
vi.mock('./spaces/SpaceView', () => ({ default: () => <div>Space view</div> }));
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

const crumb = () => document.querySelector('.terminal-topbar-breadcrumb')?.textContent?.replace(/\s+/g, ' ').trim();
const rail = (name: string) => screen.getByRole('navigation', { name: 'Areas' }).querySelector<HTMLButtonElement>(`[data-area="${name}"]`)!;

describe('TerminalShell areas', () => {
  beforeEach(() => {
    openScheduledHome();
    sessionStorage.clear();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
  });

  it('returns from Chat to the exact Page with the topbar and forwards with the shortcut', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_NATIVE_PAGE_EVENT, { detail: { pageId: 'p1', workspaceId: 'w1', backendConnectionId: 'local' } })); });
    expect(await screen.findByText('Space view')).toBeTruthy();
    fireEvent.click(rail('conversations'));
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate back' }));
    expect(await screen.findByText('Space view')).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem('michi.native-page-route')!).pageId).toBe('p1');
    fireEvent.keyDown(window, { key: ']', metaKey: true });
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    fireEvent.keyDown(window, { key: '[', metaKey: true });
    expect(await screen.findByText('Space view')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate forward' }));
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Navigate forward' }).disabled).toBe(true);
  });

  it('opens Settings over the current area and remembers its section when reopened', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    expect(rail('conversations').getAttribute('aria-current')).toBe('page');
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(await screen.findByText('Conversation dashboard')).toBeTruthy();
    const dashboard = screen.getByText('Conversation dashboard');

    fireEvent.click(rail('settings'));
    expect(await screen.findByText('Appearance pane')).toBeTruthy();
    expect(screen.getByText('Conversation dashboard')).toBe(dashboard);
    // The conversation sidebar stays under the Settings window.
    expect(screen.getByRole('tablist', { name: 'Sidebar view' })).toBeTruthy();
    expect(rail('conversations').getAttribute('aria-current')).toBe('page');
    expect(rail('settings').getAttribute('aria-expanded')).toBe('true');
    expect(document.documentElement.dataset.nativeSurfacesVisible).toBe('false');
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'Runtime & model' }));
    expect(await screen.findByText('Model pane')).toBeTruthy();

    fireEvent.click(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(screen.getByText('Conversation dashboard')).toBe(dashboard);
    expect(document.documentElement.dataset.nativeSurfacesVisible).toBe('true');

    fireEvent.click(rail('settings'));
    expect(await screen.findByText('Model pane')).toBeTruthy();
    expect(rail('settings').hasAttribute('aria-current')).toBe(false);
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.click(rail('scheduled'));
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    // Pages upkeep runs when conversations go quiet, not on a schedule: Scheduled does not list it (Q8).
    expect(screen.queryByText('Michi · Pages upkeep')).toBeNull();
  });

  it('toggles the drawer with Cmd+, while preserving the page and its shortcuts underneath', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    // These are page shortcuts: Settings owns keyboard interaction while open.
    fireEvent.keyDown(window, { key: '0', metaKey: true });
    expect(screen.getByText('Conversation dashboard')).toBeTruthy();
    expect(screen.queryByText('Conversation home')).toBeNull();
    dialog.focus();
    fireEvent.keyDown(dialog, { key: ',', metaKey: true });
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(screen.getByText('Conversation dashboard')).toBeTruthy();
  });

  it('keeps the open Space mounted when global Settings opens and closes', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_NATIVE_PAGE_EVENT, { detail: { pageId: 'p1', workspaceId: 'w1', backendConnectionId: 'local' } })); });
    const space = await screen.findByText('Space view');
    fireEvent.click(rail('settings'));
    expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(rail('spaces').getAttribute('aria-current')).toBe('page');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByText('Space view')).toBe(space);
    expect(JSON.parse(sessionStorage.getItem('michi.native-page-route')!).pageId).toBe('p1');
  });

  it('always opens Spaces on its Home, even after a Space page was open', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('spaces'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Areas' })).toBeTruthy();
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_NATIVE_PAGE_EVENT, { detail: { pageId: 'p1', workspaceId: 'w1', backendConnectionId: 'local' } })); });
    expect(await screen.findByText('Space view')).toBeTruthy();

    fireEvent.click(rail('conversations'));
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    fireEvent.click(rail('spaces'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
    expect(screen.queryByText('Space view')).toBeNull();
  });

  it('records Scheduled list and details separately and restores them across areas', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('scheduled'));
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Digest' }));
    expect(await screen.findByText('Job detail page')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate back' }));
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate back' }));
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    fireEvent.keyDown(window, { key: ']', metaKey: true });
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    fireEvent.keyDown(window, { key: ']', metaKey: true });
    expect(await screen.findByText('Job detail page')).toBeTruthy();
    fireEvent.click(rail('conversations'));
    expect(await screen.findByText('Conversation home')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Navigate back' }));
    expect(await screen.findByText('Job detail page')).toBeTruthy();
    fireEvent.click(rail('scheduled'));
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    expect(screen.queryByText('Job detail page')).toBeNull();
  });

  it('opens a job from the Scheduled sidebar under its crumb, and Settings from its link event', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    fireEvent.click(rail('scheduled'));
    expect(await screen.findByText('Scheduled page')).toBeTruthy();
    expect(crumb()).toBe('SCHEDULED');
    fireEvent.click(screen.getByRole('button', { name: 'Digest' }));
    expect(await screen.findByText('Job detail page')).toBeTruthy();

    act(() => { window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'runtime' } })); });
    expect(await screen.findByText('Model pane')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    act(() => { window.dispatchEvent(new CustomEvent('michi:nav-page', { detail: { page: 'settings' } })); });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(screen.getByText('Job detail page')).toBeTruthy();
    openScheduledHome();
  });
});
