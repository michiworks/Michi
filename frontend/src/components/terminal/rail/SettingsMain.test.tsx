import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { setKnownBackendConnections } from '../../../config/backendConnections';
import { AuthSessionContext } from '../../../services/auth';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { companionSnapshot } from '../../../test/companionFixtures';
import { OPEN_SETTINGS_SECTION_EVENT, requestMetaAgentSettings } from '../scheduled/metaAgent/metaAgentNav';
import { useOpenSettingsPage, useSettingsTarget } from '../pages/settings/settingsPhone';
import SettingsMain, { type SettingsLevel } from './SettingsMain';
import { settingsPageForRequest, type SettingsPage } from './settingsPages';
import { requestSettings, resetSettingsRequestsForTests } from './settingsRequests';

const store = vi.hoisted(() => ({
  metaAgentAlert: false,
  projects: [] as Array<{ id: string; deletedAt?: number; system?: string; trees: Array<{ id: string; rootNodeId: string; archivedAt?: number }> }>,
  nodes: {} as Record<string, { nodeId: string; projectId: string; deletionGroupId?: string; deletedAt?: number; pageId?: string | null }>,
  agentStatus: null as null | { runtime: string; label: string; model?: string },
  newSkill: vi.fn(),
}));
vi.mock('../../../state/metaAgent/useMetaAgentOverview', () => ({ useMetaAgentSettingsAlert: () => store.metaAgentAlert }));
vi.mock('../companion/CompanionSettings', () => ({
  default: function CompanionSettingsStub() {
    // What a request pointed at on this page, and a link to another page, as the real page has them.
    const target = useSettingsTarget();
    const open = useOpenSettingsPage();
    return <div>
      <p>Agent settings{target ? `, pointing at ${target}` : ''}</p>
      <button type="button" onClick={() => open('notifications', 'When Michi’s windows are closed')}>Stub link</button>
    </div>;
  },
}));
vi.mock('../pages/settings/ModelPane', () => ({ ModelPane: () => <div>Model pane</div> }));
vi.mock('../pages/settings/MemoryPane', () => ({ MemoryPane: () => <div>Memory pane</div> }));
vi.mock('./GeneralTopicPage', () => ({ default: ({ page }: { page: string }) => <div>Topic page: {page}</div> }));
vi.mock('../pages/settings/TrashPane', async () => {
  const { useSettingsBack } = await vi.importActual<typeof import('../pages/settings/settingsPhone')>('../pages/settings/settingsPhone');
  // An item open inside the page: the shell's header Back closes it first.
  return { TrashPane: () => {
    const [open, setOpen] = React.useState(false);
    useSettingsBack(React.useMemo(() => open ? () => setOpen(false) : null, [open]));
    return open ? <div>Trash item</div> : <button type="button" onClick={() => setOpen(true)}>Open trash item</button>;
  } };
});
vi.mock('../pages/settings/ArchivedPane', () => ({ ArchivedPane: () => <div>Archived pane</div> }));
vi.mock('../pages/settings/SkillsPane', async () => {
  const { useSettingsHeaderAction, useSettingsPageTitle } = await vi.importActual<typeof import('../pages/settings/settingsPhone')>('../pages/settings/settingsPhone');
  // Its action comes once its listing has; a skill opened in it takes the page's title.
  return { SkillsPane: () => {
    const [listed, setListed] = React.useState(false);
    const [open, setOpen] = React.useState(false);
    React.useEffect(() => { void Promise.resolve().then(() => setListed(true)); }, []);
    useSettingsHeaderAction(listed && !open ? 'New skill' : null, store.newSkill, { short: 'New' });
    useSettingsPageTitle(open);
    return open ? <h1>review-pr</h1> : <div>Skills pane<button type="button" onClick={() => setOpen(true)}>Open skill</button></div>;
  } };
});
vi.mock('../../../services/api/skills', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../services/api/skills')>(),
  listSkills: async () => ({ skills: [{ origin: 'library' }, { origin: 'library' }, { origin: 'runtime' }], errors: [], libraryAvailable: true }),
}));
vi.mock('../../../state/prefs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../state/prefs')>();
  const prefs = { ...actual.DEFAULT_PREFS, terminalPalette: 'bone' as const, terminalAccentOverrides: {}, notifications: 'approval-only' as const };
  return { ...actual, usePrefs: () => ({ prefs, setPref: () => {} }) };
});
vi.mock('../../../state/chatStore', async () => {
  const actual = await vi.importActual<any>('../../../state/chatStore');
  return {
    ...actual,
    useChatProjects: () => ({ activeProject: null, projects: store.projects, agentStatus: store.agentStatus }),
    useStructuralSelector: (selector: (nodes: typeof store.nodes) => unknown) => selector(store.nodes),
  };
});

/** Settings with its page and level owned by a host, as the shell does. */
function Host({ initial = 'appearance', initialView = 'menu', stacked = false, onPageChange, onNav = () => {}, workspaceReady, backRef, onHeaderAction }: {
  initial?: SettingsPage;
  initialView?: SettingsLevel;
  stacked?: boolean;
  onPageChange?: (page: SettingsPage) => void;
  onNav?: (page: string) => void;
  workspaceReady?: boolean;
  backRef?: { current: (() => void) | null };
  onHeaderAction?: React.ComponentProps<typeof SettingsMain>['onHeaderAction'];
}) {
  const [page, setPage] = React.useState<SettingsPage>(initial);
  const [view, setView] = React.useState<SettingsLevel>(initialView);
  // The shell opens the page a request names (TerminalShell does the same).
  React.useEffect(() => {
    const onSection = (event: Event) => {
      const requested = settingsPageForRequest((event as CustomEvent<{ section?: unknown }>).detail?.section);
      if (requested) { setPage(requested); setView('section'); }
    };
    window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
    return () => window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, onSection);
  }, []);
  return <>
    <SettingsMain page={page} onPageChange={(next) => { setPage(next); onPageChange?.(next); }} view={view} onViewChange={setView}
      stacked={stacked} onNav={onNav} workspaceReady={workspaceReady} backRef={backRef} onHeaderAction={onHeaderAction} />
    {/* The shell's header Back, on a phone. */}
    <button type="button" onClick={() => setView('menu')}>Host back</button>
    {/* A request for one page, like Pages upkeep's alert. */}
    <button type="button" onClick={requestMetaAgentSettings}>Host request</button>
  </>;
}

const sections = () => screen.getByRole('navigation', { name: 'Settings sections' });
const button = (name: string) => within(sections()).getByRole('button', { name, exact: true } as never);
const description = (element: HTMLElement) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? null;
const root = () => document.querySelector<HTMLElement>('.terminal-settings')!;

beforeEach(() => {
  store.metaAgentAlert = false;
  store.projects = [
    { id: 'ws-1', trees: [{ id: 't-live', rootNodeId: 'root' }, { id: 't-arch', rootNodeId: 'kept', archivedAt: 4 }, { id: 't-arch-trashed', rootNodeId: 'a', archivedAt: 3 }] },
    { id: 'ws-gone', deletedAt: 5, trees: [] },
    { id: 'ws-assistant', system: 'assistant', trees: [{ id: 't-helper', rootNodeId: 'helper-root', archivedAt: 6 }] },
  ];
  store.nodes = {
    root: { nodeId: 'root', projectId: 'ws-1' },
    kept: { nodeId: 'kept', projectId: 'ws-1' },
    a: { nodeId: 'a', projectId: 'ws-1', deletionGroupId: 'del-1', deletedAt: 7 },
    helper: { nodeId: 'helper', projectId: 'ws-1', deletionGroupId: 'del-2', pageId: 'page-1' },
    arch: { nodeId: 'arch', projectId: 'ws-1', deletionGroupId: 'arch-1' },
    'helper-root': { nodeId: 'helper-root', projectId: 'ws-assistant' },
    'helper-gone': { nodeId: 'helper-gone', projectId: 'ws-assistant', deletionGroupId: 'del-3' },
  };
  store.agentStatus = { runtime: 'claude', label: 'Claude Code', model: 'claude-opus-5-5' };
  setKnownBackendConnections([]);
  resetCompanionStoreForTests();
  resetSettingsRequestsForTests();
});

/** The agent goes by the name the user gave it. */
function nameAgent(displayName: string) {
  const snapshot = companionSnapshot();
  resetCompanionStoreForTests({ snapshot: { ...snapshot, settings: { ...snapshot.settings, displayName } } });
}

describe('Settings window', () => {
  it('lists every page in its group, with Trash and Archived counts and keyboard shortcuts', () => {
    render(<Host />);
    expect(root().classList.contains('terminal-settings--window')).toBe(true);
    expect(within(sections()).getAllByRole('group').map((group) => group.getAttribute('aria-labelledby') && document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent))
      .toEqual(['Agent', 'Workspace', 'App', 'Data']);
    const pagesIn = (name: string) => within(within(sections()).getByRole('group', { name })).getAllByRole('button').map((item) => item.querySelector('span')?.textContent);
    expect(pagesIn('Agent')).toEqual(['Runtime & model', 'Michi', 'Memory', 'Skills']);
    expect(pagesIn('Workspace')).toEqual(['Machines', 'Scheduled jobs', 'Links']);
    // Update is a phone's, and Account shows once someone is signed in.
    expect(pagesIn('App')).toEqual(['Appearance', 'Notifications', 'Keyboard shortcuts']);
    expect(pagesIn('Data')).toEqual(['Trash', 'Archived', 'Backup & restore']);
    // A deleted thread group plus a deleted workspace; the page helper is not a thread,
    // and the assistant's system workspace keeps its history out of both counts.
    expect(description(button('Trash'))).toBe('2');
    // An archived node plus an archived thread; the archived thread moved to Trash is Trash's.
    expect(description(button('Archived'))).toBe('2');
    expect(button('Appearance').getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeTruthy();
  });

  it('opens a page from its group, Trash and Archived included', async () => {
    const onPageChange = vi.fn();
    const onNav = vi.fn();
    render(<Host onPageChange={onPageChange} onNav={onNav} />);
    fireEvent.click(button('Notifications'));
    expect(onPageChange).toHaveBeenCalledWith('notifications');
    expect(await screen.findByText('Topic page: notifications')).toBeTruthy();
    expect(button('Notifications').getAttribute('aria-current')).toBe('page');
    fireEvent.click(button('Keyboard shortcuts'));
    expect(await screen.findByText('Topic page: shortcuts')).toBeTruthy();
    fireEvent.click(button('Trash'));
    expect(onPageChange).toHaveBeenLastCalledWith('trash');
    expect(screen.getByRole('heading', { level: 1, name: 'Trash' })).toBeTruthy();
    expect(button('Trash').getAttribute('aria-current')).toBe('page');
    fireEvent.click(button('Archived'));
    expect(await screen.findByText('Archived pane')).toBeTruthy();
    expect(onNav).not.toHaveBeenCalled();
  });

  it('marks the pages that need attention', () => {
    store.metaAgentAlert = true;
    setKnownBackendConnections([{ id: 'dd', name: 'Dev desktop', transport: 'ssh', tunnelStatus: 'error', hasToken: true, createdAt: 1, updatedAt: 1 }]);
    render(<Host />);
    // Pages upkeep's alert now marks Settings › <name>, where its settings are.
    expect(button('Michi, needs attention')).toBeTruthy();
    expect(button('Machines, connection issue')).toBeTruthy();
    expect(document.querySelectorAll('.settings-window__alert')).toHaveLength(2);
  });

  it('opens Memory once workspaces load', async () => {
    const view = render(<Host workspaceReady={false} />);
    view.rerender(<Host workspaceReady />);
    fireEvent.click(button('Memory'));
    expect(await screen.findByText('Memory pane')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Memory' })).toBeTruthy();
  });

  it('waits for workspaces before showing Memory', () => {
    render(<Host initial="memory" workspaceReady={false} />);
    expect(screen.getByRole('status').textContent).toContain('Loading workspaces');
    expect(screen.queryByText('Memory pane')).toBeNull();
  });

  it('lists Account only for a signed-in user', () => {
    const user = { email: 'someone@example.com', name: 'Someone' };
    render(<AuthSessionContext.Provider value={{ user } as never}><Host /></AuthSessionContext.Provider>);
    const app = within(sections()).getByRole('group', { name: 'App' });
    expect(within(app).getAllByRole('button').map((item) => item.textContent)).toEqual(['Appearance', 'Notifications', 'Keyboard shortcuts', 'Account']);
  });

  it('searches names, descriptions and preference keys, and opens a result on its page', async () => {
    const onPageChange = vi.fn();
    render(<Host initial="notifications" onPageChange={onPageChange} />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'motion' } });
    const results = screen.getByRole('region', { name: 'Search results' });
    const names = within(results).getAllByRole('button').map((hit) => hit.querySelector('.settings-window__name')?.textContent);
    expect(names[0]).toBe('Reduce motion');
    expect(names).toContain('Pane animation');
    expect(within(results).getByText('App › Appearance › Panes')).toBeTruthy();
    // While searching, no page is the current one.
    expect(button('Notifications').hasAttribute('aria-current')).toBe(false);
    // A preference key finds its setting too.
    fireEvent.change(search, { target: { value: 'theme.codeWrap' } });
    expect(within(screen.getByRole('region', { name: 'Search results' })).getByText('Code wrap')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'motion' } });
    // Enter opens the first result: its page, with the query cleared.
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onPageChange).toHaveBeenLastCalledWith('appearance');
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeTruthy();
  });

  it('opens Advanced for an advanced setting a result points at', async () => {
    render(<Host initial="notifications" />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: 'corner radius' } });
    fireEvent.click(within(screen.getByRole('region', { name: 'Search results' })).getByRole('button'));
    expect(await screen.findByRole('slider', { name: 'Corner radius' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Advanced/i }).getAttribute('aria-expanded')).toBe('true');
  });

  it('says when nothing matches, and Escape clears the query before it reaches the window', () => {
    const onWindowKey = vi.fn();
    window.addEventListener('keydown', onWindowKey);
    try {
      render(<Host />);
      const search = screen.getByRole('searchbox', { name: 'Search settings' });
      fireEvent.change(search, { target: { value: 'zzzz' } });
      expect(screen.getByRole('status').textContent).toBe('No settings match “zzzz”.');
      fireEvent.keyDown(search, { key: 'Escape' });
      expect((search as HTMLInputElement).value).toBe('');
      expect(onWindowKey).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeTruthy();
      // With no query, Escape goes on to the window, which closes it.
      fireEvent.keyDown(search, { key: 'Escape' });
      expect(onWindowKey).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('keydown', onWindowKey);
    }
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])('keeps the query on the Esc or Enter that ends an IME composition (%o)', (ime) => {
    render(<Host />);
    const search = screen.getByRole('searchbox', { name: 'Search settings' });
    fireEvent.change(search, { target: { value: '主题' } });
    fireEvent.keyDown(search, { key: 'Escape', ...ime });
    fireEvent.keyDown(search, { key: 'Enter', ...ime });
    expect(search).toHaveProperty('value', '主题');
    expect(screen.getByRole('region', { name: 'Search results' })).toBeTruthy();
  });

  it('takes ⌘F or Ctrl+F for its search while open', () => {
    const behind = vi.fn();
    window.addEventListener('keydown', behind);
    try {
      render(<Host />);
      const search = screen.getByRole('searchbox', { name: 'Search settings' });
      button('Notifications').focus();
      fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
      expect(document.activeElement).toBe(search);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  it('shows a page’s primary action beside its title, which keeps its place and focus', async () => {
    render(<Host initial="skills" />);
    const heading = screen.getByRole('heading', { level: 1, name: 'Skills' });
    heading.focus();
    fireEvent.click(await screen.findByRole('button', { name: 'New skill' }));
    expect(store.newSkill).toHaveBeenCalledOnce();
    expect(heading.isConnected && heading.parentElement?.classList.contains('settings-titlebar')).toBe(true);
    expect(document.activeElement).toBe(heading);
    fireEvent.click(screen.getByRole('button', { name: 'Open skill' }));
    expect(screen.getAllByRole('heading', { level: 1 }).map((title) => title.textContent)).toEqual(['review-pr']);
  });

  it('shows the Appearance preview beside its settings', () => {
    render(<Host />);
    expect(screen.getByRole('complementary', { name: 'Preview' })).toBeTruthy();
  });
});

describe('Settings › <name>', () => {
  it('is called by the agent’s name in the list, its heading and search, and the name follows a rename', async () => {
    nameAgent('Robin');
    render(<Host initial="companion" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Robin' })).toBeTruthy();
    expect(button('Robin').getAttribute('aria-current')).toBe('page');
    expect(within(sections()).queryByRole('button', { name: /meta agent|companion/i })).toBeNull();
    act(() => nameAgent('Kit'));
    expect(screen.getByRole('heading', { level: 1, name: 'Kit' })).toBeTruthy();
    // Searching the old names finds the agent's page, by its name.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search settings' }), { target: { value: 'meta agent' } });
    const results = screen.getByRole('region', { name: 'Search results' });
    expect(within(results).getAllByText('Agent › Kit › Pages upkeep').length).toBeGreaterThan(0);
    expect(results.querySelector('.settings-window__hits')!.textContent).not.toMatch(/meta agent/i);
  });

  it('points at the setting a request names, on a page already open or opened by it', async () => {
    render(<Host initial="companion" initialView="section" />);
    expect(await screen.findByText('Agent settings')).toBeTruthy();
    act(() => requestSettings('companion', 'Name'));
    expect(await screen.findByText('Agent settings, pointing at Name')).toBeTruthy();
    // A link on the page opens another page at one of its settings.
    fireEvent.click(screen.getByRole('button', { name: 'Stub link' }));
    expect(await screen.findByText('Topic page: notifications')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeTruthy();
  });

  it('takes a request made before Settings opened once its page shows, and only once', async () => {
    act(() => requestSettings('companion', 'Notes'));
    const view = render(<Host initial="companion" initialView="section" />);
    expect(await screen.findByText('Agent settings, pointing at Notes')).toBeTruthy();
    view.unmount();
    render(<Host initial="companion" initialView="section" />);
    expect(await screen.findByText('Agent settings')).toBeTruthy();
  });
});

describe('Settings list on a phone', () => {
  const row = (name: string) => screen.getByRole('button', { name, exact: true } as never);

  it('groups one row per topic, each with its current value, and has no keyboard shortcuts or search', async () => {
    render(<Host stacked />);
    expect(root().getAttribute('data-view')).toBe('menu');
    const agent = within(sections()).getByRole('group', { name: 'Agent' });
    expect(within(agent).getAllByRole('button').map((item) => item.getAttribute('aria-label'))).toEqual(['Runtime & model', 'Michi', 'Memory', 'Skills']);
    expect(description(row('Runtime & model'))).toBe('Claude · Opus 5.5');
    expect(description(row('Appearance'))).toBe('Bone · Rust');
    expect(description(row('Notifications'))).toBe('Approval only');
    expect(description(row('Links'))).toBe('Michi Browser');
    expect(description(row('Machines'))).toBe('This machine');
    expect(description(row('Trash'))).toBe('2');
    // The library's skills, not the runtimes'.
    expect(await screen.findByText('2', { selector: '[data-row="skills"] .settings-phone__value' })).toBeTruthy();
    // Phone access is part of Machines, not a row of its own.
    expect(within(within(sections()).getByRole('group', { name: 'Workspace' })).getAllByRole('button').map((item) => item.getAttribute('aria-label')))
      .toEqual(['Machines', 'Scheduled jobs', 'Links']);
    expect(screen.queryByRole('button', { name: /shortcuts/i })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
    // A phone updates the machine it opened; the desktop window has no Update page.
    expect(within(within(sections()).getByRole('group', { name: 'App' })).getAllByRole('button').map((item) => item.getAttribute('aria-label')))
      .toEqual(['Appearance', 'Notifications', 'Update']);
    expect(within(within(sections()).getByRole('group', { name: 'Data' })).getAllByRole('button').map((item) => item.getAttribute('aria-label')))
      .toEqual(['Trash', 'Archived', 'Backup & restore']);
    expect(description(row('Archived'))).toBe('2');
    expect(root().querySelectorAll('.settings-phone__chevron')).toHaveLength(13);
  });

  it('names a machine with a connection issue, and the agent when its Pages upkeep needs attention', () => {
    store.metaAgentAlert = true;
    setKnownBackendConnections([{ id: 'dd', name: 'Dev desktop', transport: 'ssh', tunnelStatus: 'error', hasToken: true, createdAt: 1, updatedAt: 1 }]);
    render(<Host stacked />);
    expect(description(row('Machines, connection issue'))).toBe('Connection issue');
    expect(description(row('Michi, needs attention'))).toBe('Needs attention');
  });

  it('opens a page alone, focuses its heading, and returns focus to its row on Back', async () => {
    const onPageChange = vi.fn();
    render(<Host stacked onPageChange={onPageChange} />);
    fireEvent.click(row('Notifications'));
    expect(onPageChange).toHaveBeenCalledWith('notifications');
    expect(root().getAttribute('data-view')).toBe('section');
    expect(await screen.findByText('Topic page: notifications')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Notifications' }));
    fireEvent.click(screen.getByRole('button', { name: 'Host back' }));
    expect(root().getAttribute('data-view')).toBe('menu');
    expect(document.activeElement).toBe(row('Notifications'));
  });

  it('opens a request for the old Meta agent page at Settings › <name> › Pages upkeep', async () => {
    render(<Host stacked />);
    fireEvent.click(screen.getByRole('button', { name: 'Host request' }));
    expect(root().getAttribute('data-view')).toBe('section');
    expect(screen.getByRole('heading', { level: 1, name: 'Michi' })).toBeTruthy();
    expect(await screen.findByText('Agent settings, pointing at Pages upkeep')).toBeTruthy();
  });

  it('opens Trash in the drawer, and the header Back closes an item open in it before the page', async () => {
    const onNav = vi.fn();
    const backRef: { current: (() => void) | null } = { current: null };
    render(<Host stacked onNav={onNav} backRef={backRef} />);
    fireEvent.click(row('Trash'));
    expect(root().getAttribute('data-view')).toBe('section');
    fireEvent.click(await screen.findByRole('button', { name: 'Open trash item' }));
    expect(screen.getByText('Trash item')).toBeTruthy();
    // The shell's drawer Back: an open level first, then the page.
    act(() => backRef.current!());
    expect(screen.getByRole('button', { name: 'Open trash item' })).toBeTruthy();
    expect(backRef.current).toBeNull();
    expect(onNav).not.toHaveBeenCalled();
  });

  it('hands a page’s primary action to the host’s header', async () => {
    const onHeaderAction = vi.fn();
    render(<Host stacked initial="skills" initialView="section" onHeaderAction={onHeaderAction} />);
    await waitFor(() => expect(onHeaderAction).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'New skill', short: 'New' })));
    // In the drawer the page's title has no button of its own.
    expect(screen.queryByRole('button', { name: 'New skill' })).toBeNull();
  });

  it('shows no counts before workspaces load', () => {
    render(<Host stacked workspaceReady={false} />);
    expect(row('Trash').hasAttribute('aria-describedby')).toBe(false);
  });
});
