import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { HomeCard, HomeCardsDto } from 'michi-shared';
import TerminalHome from './Home';
import { PrefsProvider } from '../../../state/prefs';
import { __resetHomeCardsCacheForTests } from '../../../state/homeCards/useHomeCards';
import { AppearancePane } from './settings/AppearancePane';
import type { ChatNodeState, Project } from '../../../state/chatTypes';
import { useZhCnDefaultLocale } from '../../../test/zhCnLocale';
import { resetCompanionStoreForTests } from '../../../state/companion/companionStore';
import { getCompanionPanelState, resetCompanionPanelForTests } from '../../../state/companion/companionPanel';
import { companionItem, companionSnapshot } from '../../../test/companionFixtures';

// What Home asks of its composer. The insertion itself is covered by
// ManageComposer.insert.test.tsx and Home.composerInsert.test.tsx.
const composer = vi.hoisted(() => ({ insert: vi.fn(), startMention: vi.fn() }));
vi.mock('../manage/ManageComposer', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  const FakeComposer = forwardRef(function FakeComposer(props: { toolbarLeftPrefix?: React.ReactNode }, ref) {
    useImperativeHandle(ref, () => composer);
    return <div data-testid="composer">{props.toolbarLeftPrefix}</div>;
  });
  return { default: FakeComposer };
});
vi.mock('../home/ChatHomeDocument', () => ({ default: ({ page }: { page: { title: string } }) => <section aria-label="Home content">{page.title}</section> }));
const chip = vi.hoisted(() => ({ props: vi.fn((_props: unknown) => null) }));
vi.mock('../HomeWorkspaceChip', () => ({ HomeWorkspaceChip: (props: unknown) => chip.props(props) }));

const api = vi.hoisted(() => ({ fetchHomeCards: vi.fn(), markHomeCardUsed: vi.fn() }));
vi.mock('../../../services/api/homeCards', async () => ({
  ...(await vi.importActual<object>('../../../services/api/homeCards')),
  fetchHomeCards: api.fetchHomeCards,
  markHomeCardUsed: api.markHomeCardUsed,
}));

function node(nodeId: string, extra: Partial<ChatNodeState> = {}): ChatNodeState {
  return { nodeId, chatId: null, projectId: 'p1', kind: 'chat', title: nodeId, messages: [], followUps: [], status: 'idle', ...extra } as ChatNodeState;
}

const store = vi.hoisted(() => ({
  projects: [] as Project[],
  nodes: {} as Record<string, ChatNodeState>,
  hydrated: true,
  selectProject: vi.fn(),
  activateTree: vi.fn(),
  enterChatsWorkspace: vi.fn(async () => 'chats-default'),
}));
vi.mock('../../../state/chatStore', async () => ({
  ...(await vi.importActual<object>('../../../state/chatStore')),
  useChatStore: () => ({
    projects: store.projects,
    activeProject: store.projects[0] ?? null,
    activeProjectId: store.projects[0]?.id ?? null,
    hydrated: store.hydrated,
    selectProject: store.selectProject,
    activateTree: store.activateTree,
    enterChatsWorkspace: store.enterChatsWorkspace,
  }),
  useStructuralSelector: (selector: (n: Record<string, ChatNodeState>) => unknown) => selector(store.nodes),
}));

const withThreads: Project[] = [
  { id: 'p1', name: 'sample-project', createdAt: 0, activeTreeId: 't1', chatIds: ['a'], edges: [],
    trees: [{ id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: 10 }] },
  { id: 'p2', name: 'agent-desk', createdAt: 0, activeTreeId: null, chatIds: [], edges: [], trees: [] },
] as unknown as Project[];
const withoutThreads: Project[] = [
  { id: 'p1', name: 'sample-project', createdAt: 0, activeTreeId: null, chatIds: [], edges: [], trees: [] },
] as unknown as Project[];

function card(id: string, extra: Partial<HomeCard> = {}): HomeCard {
  return {
    id, kind: 'continue', label: '接着做 · sample-project', source: { workspaceId: 'p1' }, title: `Title ${id}`,
    reason: `Reason ${id}`, buttonText: '接着做', prompt: `Prompt ${id}`, workspaceId: 'p1', ...extra,
  };
}
const six = (prefix: string) => Array.from({ length: 6 }, (_, i) => card(`${prefix}${i}`));
function answer(extra: Partial<HomeCardsDto> = {}): HomeCardsDto {
  return {
    greeting: { text: '早上好。昨晚 3 条线有进展。', detail: 'Michi 0.9 还有 5 天发布。' },
    sets: [{ cards: six('a') }, { cards: six('b') }],
    generatedAt: 1, inputFingerprint: 'fp', ...extra,
  };
}

const inserted = () => composer.insert.mock.calls.map(([text]) => text);
const cardTitles = () => screen.queryAllByTestId('home-card').map((el) => el.querySelector('.home-card__title')!.textContent);
const recentTitles = () => screen.queryAllByTestId('home-recent').map((el) => el.querySelector('.home-card__title')!.textContent);
/** Cards the user chose through the agent (edit_home): the only stored cards Home still shows. */
const chosen = (extra: Partial<HomeCardsDto> = {}) => answer({ cardsCustomized: true, ...extra });
const greetingText = () => screen.getByRole('heading', { level: 1 }).textContent;

const submitted = vi.fn();
async function renderHome() {
  const view = render(<TerminalHome onSubmitted={submitted} />);
  await waitFor(() => expect(api.fetchHomeCards).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

describe('TerminalHome', () => {
  beforeEach(() => {
    store.projects = withThreads;
    store.nodes = { a: node('a') };
    store.hydrated = true;
    store.selectProject.mockReset();
    store.activateTree.mockReset();
    store.enterChatsWorkspace.mockClear();
    resetCompanionStoreForTests();
    resetCompanionPanelForTests();
    chip.props.mockClear();
    submitted.mockReset();
    composer.insert.mockReset();
    composer.startMention.mockReset();
    api.fetchHomeCards.mockReset().mockResolvedValue(answer());
    api.markHomeCardUsed.mockReset().mockResolvedValue(undefined);
    __resetHomeCardsCacheForTests();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('switches Home between default and Pages content from Settings and restores the saved choice', async () => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ homeRecommendations: true }));
    api.fetchHomeCards.mockResolvedValue(answer({ contentMode: 'page', contentPage: { id: 'home', title: 'My home layout' } as never }));
    const view = render(<PrefsProvider><AppearancePane /><TerminalHome onSubmitted={submitted} /></PrefsProvider>);
    await screen.findByRole('region', { name: 'Home content' });
    const toggle = screen.getByRole('switch', { name: 'Pages recommendations on Home' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Home content' })).toBeNull();
    expect(cardTitles()).toEqual([]);
    expect(screen.getByTestId('composer')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Another road diverged');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('michi:v1:prefs')!).homeRecommendations).toBe(false));
    view.unmount();
    render(<PrefsProvider><AppearancePane /><TerminalHome onSubmitted={submitted} /></PrefsProvider>);
    expect(screen.getByRole('switch', { name: 'Pages recommendations on Home' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('region', { name: 'Home content' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Pages recommendations on Home' }));
    await screen.findByRole('region', { name: 'Home content' });
    localStorage.removeItem('michi:v1:prefs');
  });

  it('holds the greeting and cards places while Home loads, then fades its content in around the same composer', async () => {
    let resolve!: (value: HomeCardsDto) => void;
    api.fetchHomeCards.mockReturnValue(new Promise<HomeCardsDto>((done) => { resolve = done; }));
    await renderHome();
    const input = screen.getByTestId('composer');
    const home = document.querySelector('.home-page')!;
    expect(home.getAttribute('aria-busy')).toBe('true');
    expect(document.querySelector('.michi-home-eyebrow')).not.toBeNull();
    expect(document.querySelector('.home-greeting__skeleton')).not.toBeNull();
    expect(document.querySelectorAll('.home-card-skeleton')).toHaveLength(3);
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () => resolve(answer({ greeting: null, contentMode: 'page', contentPage: { id: 'home', title: 'My home layout' } as never })));
    await screen.findByRole('region', { name: 'Home content' });
    expect(home.hasAttribute('aria-busy')).toBe(false);
    expect(home.hasAttribute('data-arriving')).toBe(true);
    expect(document.querySelector('.home-cards--skeleton')?.hasAttribute('data-leaving')).toBe(true);
    expect(document.querySelector('.home-greeting__skeleton')).toBeNull();
    expect(greetingText()).toMatch(/^_ Good (morning|afternoon|evening)$/);
    expect(screen.getByTestId('composer')).toBe(input);
    await waitFor(() => expect(home.hasAttribute('data-arriving')).toBe(false), { timeout: 2000 });
    expect(document.querySelector('.home-cards--skeleton')).toBeNull();
  });

  it('coming back to Home shows its last content at once, then the fresh read', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ greeting: null, contentMode: 'page', contentPage: { id: 'home', title: 'My home layout' } as never }));
    const first = await renderHome();
    await screen.findByRole('region', { name: 'Home content' });
    first.unmount();

    let resolve!: (value: HomeCardsDto) => void;
    api.fetchHomeCards.mockReturnValue(new Promise<HomeCardsDto>((done) => { resolve = done; }));
    const second = render(<TerminalHome onSubmitted={submitted} />);
    expect(screen.getByRole('region', { name: 'Home content' }).textContent).toBe('My home layout');
    expect(document.querySelector('.home-card-skeleton')).toBeNull();
    expect(document.querySelector('.home-page')?.hasAttribute('data-arriving')).toBe(false);
    await act(async () => resolve(answer({ greeting: null, contentMode: 'page', contentPage: { id: 'home', title: 'Renamed layout' } as never })));
    expect(screen.getByRole('region', { name: 'Home content' }).textContent).toBe('Renamed layout');
    second.unmount();

    // A failed read is not remembered: the next visit waits with the placeholders.
    api.fetchHomeCards.mockRejectedValue(new Error('offline'));
    (await renderHome()).unmount();
    api.fetchHomeCards.mockReturnValue(new Promise<HomeCardsDto>(() => {}));
    render(<TerminalHome onSubmitted={submitted} />);
    expect(document.querySelector('.home-page')?.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('region', { name: 'Home content' })).toBeNull();
  });

  it('coming back to Home leaves out the chosen card clicked last time', async () => {
    api.fetchHomeCards.mockResolvedValue(chosen());
    const first = await renderHome();
    fireEvent.click(screen.getAllByTestId('home-card')[0]!);
    expect(cardTitles()[0]).toBe('Title a0');
    first.unmount();
    api.fetchHomeCards.mockReturnValue(new Promise<HomeCardsDto>(() => {}));
    render(<TerminalHome onSubmitted={submitted} />);
    expect(cardTitles()).toEqual(['Title a1', 'Title a2', 'Title a3', 'Title a4', 'Title a5']);
  });

  it('greets by the time of day and never shows what Pages upkeep wrote for Home before the unification (D13)', async () => {
    useZhCnDefaultLocale();
    await renderHome();
    // English on a Chinese browser too.
    expect(document.querySelector('.michi-home-eyebrow')!.textContent).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
    expect(greetingText()).toMatch(/^_ Good (morning|afternoon|evening)$/);
    expect(document.body.textContent).not.toContain('早上好。昨晚 3 条线有进展。');
    expect(cardTitles()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Shuffle' })).toBeNull();
    expect(screen.getByTestId('composer')).toBeTruthy();
  });

  it('shows the greeting the user chose, or none when they hid it', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ greetingCustomized: true, greeting: { text: 'Ship 0.9 this week.', detail: null } }));
    const view = await renderHome();
    expect(greetingText()).toBe('_ Ship 0.9 this week.');
    view.unmount();
    api.fetchHomeCards.mockResolvedValue(answer({ greetingCustomized: true, greeting: null }));
    await renderHome();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    expect(document.querySelector('.michi-home-eyebrow')).toBeTruthy();
  });

  it('keeps the old hero and nothing under the composer while recommendations are off', async () => {
    localStorage.setItem('michi:v1:prefs', JSON.stringify({ homeRecommendations: false }));
    try {
      render(<PrefsProvider><TerminalHome onSubmitted={submitted} /></PrefsProvider>);
      await act(async () => {});
      expect(greetingText()).toContain('Another road diverged');
      expect(recentTitles()).toEqual([]);
    } finally {
      localStorage.removeItem('michi:v1:prefs');
    }
  });

  it('a chosen card puts its prompt into the composer without sending, and is marked used', async () => {
    api.fetchHomeCards.mockResolvedValue(chosen());
    await renderHome();
    fireEvent.click(screen.getAllByTestId('home-card')[0]!);
    expect(inserted()).toEqual(['Prompt a0']);
    expect(submitted).not.toHaveBeenCalled();
    expect(api.markHomeCardUsed).toHaveBeenCalledWith('a0', expect.any(String));
    // It stays on screen until the next read.
    expect(cardTitles()[0]).toBe('Title a0');
  });

  it('a chosen card moves the composer to its workspace when that is one of the user\'s', async () => {
    api.fetchHomeCards.mockResolvedValue(chosen({ sets: [{ cards: [card('x', { workspaceId: 'p2' }), card('y', { workspaceId: 'gone' }), card('z', { workspaceId: null, kind: 'tip', prompt: '' })] }] }));
    await renderHome();
    const [toP2, toGone, tip] = screen.getAllByTestId('home-card');
    fireEvent.click(toP2!);
    expect(store.selectProject).toHaveBeenCalledWith('p2');
    fireEvent.click(toGone!);
    fireEvent.click(tip!);
    expect(store.selectProject).toHaveBeenCalledTimes(1);
    expect(inserted()).toEqual(['Prompt x', 'Prompt y', '']);
  });

  it('Shuffle shows the next chosen set without asking the backend, and comes back round', async () => {
    api.fetchHomeCards.mockResolvedValue(chosen({ sets: [{ cards: six('a') }, { cards: six('b') }, { cards: [card('c0')] }] }));
    await renderHome();
    const shuffle = screen.getByRole('button', { name: 'Shuffle' });
    fireEvent.click(shuffle);
    expect(cardTitles()[0]).toBe('Title b0');
    fireEvent.click(shuffle);
    expect(cardTitles()).toEqual(['Title c0']);
    fireEvent.click(shuffle);
    expect(cardTitles()[0]).toBe('Title a0');
    expect(api.fetchHomeCards).toHaveBeenCalledTimes(1);
    expect(recentTitles()).toEqual([]);
  });

  it('sends Full summary on Pages Home to the Pages Home', async () => {
    api.fetchHomeCards.mockResolvedValue(chosen());
    await renderHome();
    const onNav = vi.fn();
    window.addEventListener('michi:nav-page', onNav);
    fireEvent.click(screen.getByRole('button', { name: /Full summary on Pages Home/ }));
    window.removeEventListener('michi:nav-page', onNav);
    expect((onNav.mock.calls[0]![0] as CustomEvent).detail).toEqual({ page: 'spaces' });
  });

  describe('direction B (Q44–Q47): Michi’s work, then Jump back in', () => {
    const recentProjects = (): Project[] => [
      { id: 'p1', name: 'Michi', createdAt: 0, activeTreeId: 't1', chatIds: ['a', 'a2', 'b', 'c', 'd'],
        edges: [{ id: 'e1', source: 'a', target: 'a2', kind: 'branch' }],
        trees: [
          { id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: 40 },
          { id: 't2', rootNodeId: 'b', createdAt: 0, lastActiveAt: 30 },
          { id: 't3', rootNodeId: 'c', createdAt: 0, lastActiveAt: 20 },
          { id: 't4', rootNodeId: 'd', createdAt: 0, lastActiveAt: 10 },
        ] },
    ] as unknown as Project[];
    const on = (extra: Parameters<typeof companionSnapshot>[0] = {}) => {
      const snapshot = companionSnapshot(extra);
      return { ...snapshot, settings: { ...snapshot.settings, paused: false, ...extra.settings } };
    };

    beforeEach(() => {
      store.projects = recentProjects();
      store.nodes = {
        a: node('a', { title: 'Fix pane focus', branchOverviewEntries: [{ at: 1, text: 'Found the focus bug.' }] }),
        a2: node('a2', { branchOverviewEntries: [{ at: 5, text: 'The branch fixed it after a reload.' }], completionSeq: 2, seenCompletionSeq: 1 }),
        b: node('b', { title: 'Draft the change', status: 'streaming' }),
        c: node('c', { title: 'Kiro flake' }),
        d: node('d', { title: 'Too old to show' }),
      };
    });

    it('shows the three latest conversations, each with its own agent’s latest line and what it is doing; one opens', async () => {
      resetCompanionStoreForTests({ availability: 'available', snapshot: on({ delegations: [
        { id: 'd1', workspaceId: 'p1', nodeId: 'b', title: 'Draft the change', state: 'following', origin: 'start_conversation', autoSend: false, createdAt: 1,
          lastSentAt: null, lastReportedAt: null, closedAt: null, closedReason: null },
      ] }) });
      await renderHome();
      expect(screen.getByRole('region', { name: 'Jump back in' })).toBeTruthy();
      expect(recentTitles()).toEqual(['Fix pane focus', 'Draft the change', 'Kiro flake']);
      const [first, second] = screen.getAllByTestId('home-recent');
      expect(first!.querySelector('.home-card__label')!.textContent).toBe('Michi');
      expect(first!.querySelector('.home-card__overview')!.textContent).toBe('The branch fixed it after a reload.');
      expect(first!.querySelector('.home-card__status')!.textContent).toMatch(/^Done · /);
      expect(second!.querySelector('.home-card__status')!.textContent).toBe('Started by Michi · running');
      expect(second!.querySelector('.home-card__overview')).toBeNull();
      const onNav = vi.fn();
      window.addEventListener('michi:nav-page', onNav);
      fireEvent.click(second!);
      window.removeEventListener('michi:nav-page', onNav);
      expect(store.activateTree).toHaveBeenCalledWith('t2', 'p1');
      expect((onNav.mock.calls[0]![0] as CustomEvent).detail).toEqual({ page: 'dashboard' });
      expect(inserted()).toEqual([]);
    });

    it('while Michi is on, one line counts its work, and Open Today opens Today', async () => {
      const today = Date.now();
      resetCompanionStoreForTests({ availability: 'available', snapshot: on({
        items: [
          companionItem('cr-1'),
          companionItem('done-1', { source: 'michi', subtype: 'michi_done', bucket: 'update', changedAt: today }),
          companionItem('done-old', { source: 'michi', subtype: 'michi_done', bucket: 'update', changedAt: today - 3 * 86_400_000 }),
        ],
        delegations: [
          { id: 'd1', workspaceId: 'p1', nodeId: 'b', title: 'Draft', state: 'following', origin: 'start_conversation', autoSend: false, createdAt: 1, lastSentAt: null, lastReportedAt: null, closedAt: null, closedReason: null },
          { id: 'd2', workspaceId: 'p1', nodeId: 'x', title: 'Closed', state: 'closed', origin: 'start_conversation', autoSend: false, createdAt: 1, lastSentAt: null, lastReportedAt: null, closedAt: 2, closedReason: 'took_over' },
        ],
      }) });
      await renderHome();
      const strip = screen.getByRole('group', { name: 'Michi’s work' });
      const counts = Array.from(strip.querySelectorAll('.home-work__count')).map((count) => [count.getAttribute('data-kind'), count.querySelector('b')!.textContent]);
      expect(counts).toEqual([['working', '1'], ['waiting', '1'], ['done', '1']]);
      fireEvent.click(within(strip).getByRole('button', { name: /Open Today/ }));
      expect(getCompanionPanelState()).toMatchObject({ open: true, tab: 'today' });
    });

    it('greets with Michi\'s latest line while it is on and the line is fresh (Q45)', async () => {
      const headline = { text: 'Two reviews came back; the nightly passed.', at: Date.now() - 60_000, kind: 'heartbeat' as const };
      resetCompanionStoreForTests({ availability: 'available', snapshot: { ...on(), headline } });
      const fresh = await renderHome();
      expect(greetingText()).toBe('_ Two reviews came back; the nightly passed.');
      fresh.unmount();
      resetCompanionStoreForTests({ availability: 'available', snapshot: { ...on(), headline: { ...headline, at: Date.now() - 4 * 3_600_000 } } });
      const stale = await renderHome();
      expect(greetingText()).toMatch(/^_ Good (morning|afternoon|evening)$/);
      stale.unmount();
      const off = on();
      resetCompanionStoreForTests({ availability: 'available', snapshot: { ...off, settings: { ...off.settings, paused: true }, headline } });
      await renderHome();
      expect(greetingText()).toMatch(/^_ Good (morning|afternoon|evening)$/);
    });

    it('without Michi (off, never turned on, no Companion) there is no work line; the greeting and the cards stay (Q47)', async () => {
      const snapshot = companionSnapshot();
      for (const state of [
        { availability: 'available' as const, snapshot: { ...snapshot, settings: { ...snapshot.settings, paused: true } } },
        { availability: 'unavailable' as const },
      ]) {
        resetCompanionStoreForTests(state);
        const view = await renderHome();
        expect(screen.queryByRole('group', { name: 'Michi’s work' })).toBeNull();
        expect(greetingText()).toMatch(/^_ Good (morning|afternoon|evening)$/);
        expect(recentTitles()).toHaveLength(3);
        view.unmount();
      }
    });
  });

  it('honors hidden recommendations instead of substituting onboarding cards', async () => {
    store.projects = withoutThreads;
    store.nodes = {};
    api.fetchHomeCards.mockResolvedValue(answer({ greeting: null, sets: [], cardsCustomized: true }));
    await renderHome();
    expect(screen.queryAllByTestId('home-card')).toHaveLength(0);
    expect(greetingText()).toMatch(/^_ Good (morning|afternoon|evening)$/);
    expect(screen.getByTestId('composer')).toBeTruthy();
  });

  it('a custom Page replaces the cards while keeping the composer', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ contentMode: 'page', contentPage: { id: 'home', title: 'My home layout' } as never }));
    await renderHome();
    expect(await screen.findByRole('region', { name: 'Home content' })).toBeTruthy();
    expect(cardTitles()).toEqual([]);
    expect(screen.getByTestId('composer')).toBeTruthy();
  });

  it('missing or hidden custom content never falls back to recommendations', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ contentMode: 'page', contentPage: null }));
    const view = await renderHome();
    expect(screen.getByRole('status').textContent).toContain('unavailable');
    expect(cardTitles()).toEqual([]);
    view.unmount();
    api.fetchHomeCards.mockResolvedValue(answer({ contentMode: 'hidden' }));
    await renderHome();
    expect(cardTitles()).toEqual([]);
    expect(screen.getByTestId('composer')).toBeTruthy();
  });

  it('gives a new user getting-started cards instead, whatever the backend holds', async () => {
    store.projects = withoutThreads;
    store.nodes = {};
    await renderHome();
    expect(cardTitles()).toEqual(['Start a conversation', 'Try branching', '@ a page', 'Open Pages']);
    expect(screen.queryByRole('button', { name: 'Shuffle' })).toBeNull();

    const [conversation, , mention, spaces] = screen.getAllByTestId('home-card');
    fireEvent.click(conversation!);
    expect(inserted()).toEqual(['Help me plan what to work on today.']);
    fireEvent.click(mention!);
    expect(composer.startMention).toHaveBeenCalledOnce();
    const onNav = vi.fn();
    window.addEventListener('michi:nav-page', onNav);
    fireEvent.click(spaces!);
    window.removeEventListener('michi:nav-page', onNav);
    expect((onNav.mock.calls[0]![0] as CustomEvent).detail).toEqual({ page: 'spaces' });
    expect(api.markHomeCardUsed).not.toHaveBeenCalled();
    expect(submitted).not.toHaveBeenCalled();
  });

  it('counts only listed threads: hidden helpers, the archive and Trash leave a user new', async () => {
    store.projects = [{
      id: 'p1', name: 'sample-project', createdAt: 0, activeTreeId: null, chatIds: ['helper', 'shelved', 'binned'], edges: [],
      trees: [
        { id: 'th', rootNodeId: 'helper', createdAt: 0, lastActiveAt: 3 },
        { id: 'ts', rootNodeId: 'shelved', createdAt: 0, lastActiveAt: 2, archivedAt: 4 },
        { id: 'tb', rootNodeId: 'binned', createdAt: 0, lastActiveAt: 1 },
      ],
    }] as unknown as Project[];
    store.nodes = { helper: node('helper', { pageId: 'pg-1' }), shelved: node('shelved'), binned: node('binned', { deletedAt: 5 }) };
    await renderHome();
    expect(cardTitles()).toEqual(['Start a conversation', 'Try branching', '@ a page', 'Open Pages']);
  });

  it('waits for the workspaces before deciding the user is new', async () => {
    store.projects = [];
    store.nodes = {};
    store.hydrated = false;
    api.fetchHomeCards.mockResolvedValue(answer({ sets: [] }));
    await renderHome();
    expect(screen.queryAllByTestId('home-card')).toHaveLength(0);
  });

  type ChipProps = { active: { id: string } | null; liveProjects: Array<{ id: string }>; onClear?: () => void };
  const lastChip = () => chip.props.mock.calls.at(-1)![0] as ChipProps;

  it('the workspace chip clears into the folder-less Chats workspace', async () => {
    await renderHome();
    expect(lastChip().active?.id).toBe('p1');
    lastChip().onClear!();
    expect(store.enterChatsWorkspace).toHaveBeenCalledTimes(1);
    expect(store.selectProject).not.toHaveBeenCalled();
  });

  it('shows the Chats workspace as no workspace, not as one to pick', async () => {
    const chats = { id: 'chats-default', name: 'Chats', createdAt: 0, activeTreeId: null, chatIds: [], edges: [], trees: [] };
    store.projects = [chats, ...withThreads] as unknown as Project[];
    await renderHome();
    expect(lastChip().active).toBeNull();
    expect(lastChip().liveProjects.map((p) => p.id)).toEqual(['p1', 'p2']);
  });
});
