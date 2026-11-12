import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompanionPanelState, noteCompanionScreen, resetCompanionPanelForTests, setCompanionTarget, type CompanionPanelTarget } from '../../../../state/companion/companionPanel';
import { resetCompanionStoreForTests } from '../../../../state/companion/companionStore';
import {
  companionScreenKey,
  companionSpacesScreen,
  resetCompanionScreenForTests,
  useCompanionSpacesScreen,
} from '../../../../state/companion/companionScreen';
import { assistantInfo } from '../../../../test/companionFixtures';
import { loadSpacesHomeIds } from '../../../../state/metaChat/spacesPages';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import { SpacesMetaChat, type SpacesChatView } from './SpacesMetaChat';

const firstRun = vi.hoisted(() => ({ data: null as unknown }));
vi.mock('../../../../state/metaAgent/spacesFirstRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaAgent/spacesFirstRun')>()),
  useSpacesFirstRun: () => ({ load: 'ready', data: firstRun.data, error: null, unreachable: false, schedulerOff: false, justFinished: false }),
}));
vi.mock('../../../../state/metaChat/spacesPages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/metaChat/spacesPages')>()),
  loadSpacesHomeIds: vi.fn(async () => {}),
}));
vi.mock('../../../../state/metaAgent/useMetaAgent', () => ({ refreshMetaAgent: vi.fn(async () => {}) }));
vi.mock('../../../../state/chatStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../state/chatStore')>()),
  useChatProjects: () => ({ projects: [{ id: 'ws1', name: 'Work', chatIds: [] }], activeProjectId: 'ws1' }),
}));

const block: CompanionPanelTarget = { backendConnectionId: 'local', workspaceId: 'ws1', pageId: 'p1', blockId: 'b1', title: 'Plan', content: '- [ ] a' };
const page = (pageId: string): SpacesChatView => ({ kind: 'page', backendConnectionId: 'local', workspaceId: 'ws1', pageId });

beforeEach(() => {
  firstRun.data = null;
  localStorage.clear();
  resetCompanionPanelForTests();
  resetCompanionScreenForTests();
  resetCompanionStoreForTests({ assistant: { status: 'ready', info: assistantInfo() as never, error: null } });
});
afterEach(() => resetCompanionStoreForTests());

describe('the Pages area’s bridge to the panel (the window is retired, §1.4)', () => {
  it("reads the home ids each time Pages is shown, and on this machine's page changes while shown", () => {
    const loads = vi.mocked(loadSpacesHomeIds);
    loads.mockClear();
    const view = render(<SpacesMetaChat active view={page('p1')}><p /></SpacesMetaChat>);
    expect(loads).toHaveBeenCalledTimes(1);
    act(() => notifyPageChanged({ backendConnectionId: 'local', workspaceId: 'ws1' }));
    expect(loads).toHaveBeenCalledTimes(2);
    act(() => notifyPageChanged({ backendConnectionId: 'mac', workspaceId: 'remote:mac:ws' }));
    expect(loads).toHaveBeenCalledTimes(2);
    view.rerender(<SpacesMetaChat active={false} view={page('p1')}><p /></SpacesMetaChat>);
    act(() => notifyPageChanged({ backendConnectionId: 'local', workspaceId: 'ws1' }));
    expect(loads).toHaveBeenCalledTimes(2);
    view.rerender(<SpacesMetaChat active view={page('p1')}><p /></SpacesMetaChat>);
    expect(loads).toHaveBeenCalledTimes(3);
  });

  it('renders the page as it is and tells the panel what Pages shows while it is on screen', () => {
    const view = render(<SpacesMetaChat active view={page('p1')}><p>The page</p></SpacesMetaChat>);
    expect(screen.getByText('The page')).toBeTruthy();
    expect(companionSpacesScreen()).toMatchObject({ view: page('p1'), workspaces: [{ id: 'ws1', name: 'Work' }] });
    view.rerender(<SpacesMetaChat active={false} view={page('p1')}><p>The page</p></SpacesMetaChat>);
    expect(companionSpacesScreen()).toBeNull();
  });

  it('lets a block target go when Pages moves to another page, or leaves Pages (F1a-review #9)', () => {
    // What CompanionPanelHost does with the screen Pages publishes.
    function Host({ page: shellPage }: { page: string }) {
      const screen = useCompanionSpacesScreen();
      const key = companionScreenKey(shellPage, screen);
      React.useEffect(() => { noteCompanionScreen(key); }, [key]);
      return null;
    }
    const view = render(<><SpacesMetaChat active view={page('p1')}><p /></SpacesMetaChat><Host page="space" /></>);
    act(() => setCompanionTarget(block));
    view.rerender(<><SpacesMetaChat active view={page('p1')}><p /></SpacesMetaChat><Host page="space" /></>);
    expect(getCompanionPanelState().target).not.toBeNull();
    view.rerender(<><SpacesMetaChat active view={page('p2')}><p /></SpacesMetaChat><Host page="space" /></>);
    expect(getCompanionPanelState().target).toBeNull();
    act(() => setCompanionTarget({ ...block, pageId: 'p2' }));
    view.rerender(<><SpacesMetaChat active={false} view={page('p2')}><p /></SpacesMetaChat><Host page="scheduled" /></>);
    expect(getCompanionPanelState().target).toBeNull();
  });

  it('opens the panel once when the Pages upkeep’s first run starts, without taking focus', () => {
    firstRun.data = {
      requestedAt: 500, haltedReason: null, summary: { state: 'waiting', summarizedAt: null },
      workspaces: [{ workspaceId: 'ws1', workspaceName: 'Work', homePageId: 'pg-home', hiddenAt: null,
        firstRun: { workspaceId: 'ws1', startedAt: 1, startSeq: 0, readCount: 1, total: 3, state: 'reading', error: null, updatedAt: 1 } }],
    };
    const view = render(<SpacesMetaChat active view={{ kind: 'home' }}><p /></SpacesMetaChat>);
    expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'chat', composerFocusSeq: 0 });
    act(() => resetCompanionPanelForTests());
    view.rerender(<SpacesMetaChat active view={{ kind: 'home' }}><p /></SpacesMetaChat>);
    view.unmount();
    render(<SpacesMetaChat active view={{ kind: 'home' }}><p /></SpacesMetaChat>);
    expect(getCompanionPanelState().open).toBe(false);
  });
});
