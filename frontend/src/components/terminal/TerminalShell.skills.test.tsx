import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import TerminalShell from './TerminalShell';
import { PrefsProvider } from '../../state/prefs';
import { OPEN_SETTINGS_SECTION_EVENT } from './scheduled/metaAgent/metaAgentNav';

vi.mock('./pages/settings/SkillsPane', () => ({ SkillsPane: () => <p>Skills pane</p> }));
// The palette's Open Skills command (state/commands.ts) navigates to 'skills'.
vi.mock('./CommandPalette', () => ({
  default: ({ setPage }: { setPage: (page: string) => void }) => <button type="button" onClick={() => setPage('skills')}>Open Skills</button>,
}));
vi.mock('./pages/Home', () => ({ default: () => <div>Conversation home</div> }));
vi.mock('../NewWorkspaceDialog', () => ({ default: () => null }));
vi.mock('./NewWorkspaceAutoOpen', () => ({ NewWorkspaceAutoOpen: () => null }));
vi.mock('./pages/Dashboard', () => ({ default: () => <div>Conversation dashboard</div> }));
vi.mock('./pages/settings/AppearancePane', () => ({ AppearancePane: () => <div>Appearance pane</div> }));
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

describe('Skills in the shell', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ onboardingCompletedAt: 1, sidebarCollapsed: false, reduceMotion: true }));
  });

  it('has no Skills page: the palette’s Open Skills opens Settings on its Skills page', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Open Skills' }));
    const settings = screen.getByRole('dialog', { name: 'Settings' });
    expect(settings.querySelector('h1')?.textContent).toBe('Skills');
    expect(await screen.findByText('Skills pane')).toBeTruthy();
  });

  it('opens Settings › Skills when a request names it', async () => {
    render(<PrefsProvider><TerminalShell /></PrefsProvider>);
    act(() => { window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'skills' } })); });
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(await screen.findByText('Skills pane')).toBeTruthy();
  });
});
