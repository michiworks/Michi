/**
 * Home while its temporary-chat switch is on: the hero says what the chat it
 * starts will and won't do, the cards and Home's page are not shown, and the
 * composer (the same one, so a draft stays) is told the chat is temporary.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { HomeCard, HomeCardsDto } from 'michi-shared';
import TerminalHome from './Home';
import { __resetHomeCardsCacheForTests } from '../../../state/homeCards/useHomeCards';
import { resetTemporaryChatDraft, setTemporaryChatDraft } from '../../../state/temporaryChatDraft';
import type { ChatNodeState, Project } from '../../../state/chatTypes';

const composer = vi.hoisted(() => ({ props: vi.fn((_props: { temporary?: boolean }) => {}), mounts: 0 }));
vi.mock('../manage/ManageComposer', async () => {
  const { forwardRef, useEffect } = await import('react');
  const FakeComposer = forwardRef(function FakeComposer(props: { temporary?: boolean }, _ref) {
    composer.props(props);
    useEffect(() => { composer.mounts += 1; }, []);
    return <div data-testid="composer" data-temporary={props.temporary ? 'true' : undefined} />;
  });
  return { default: FakeComposer };
});
vi.mock('../home/ChatHomeDocument', () => ({ default: ({ page }: { page: { title: string } }) => <section aria-label="Home content">{page.title}</section> }));
vi.mock('../HomeWorkspaceChip', () => ({ HomeWorkspaceChip: () => null }));

const api = vi.hoisted(() => ({ fetchHomeCards: vi.fn(), markHomeCardUsed: vi.fn() }));
vi.mock('../../../services/api/homeCards', async () => ({
  ...(await vi.importActual<object>('../../../services/api/homeCards')),
  fetchHomeCards: api.fetchHomeCards,
  markHomeCardUsed: api.markHomeCardUsed,
}));

const projects: Project[] = [
  { id: 'p1', name: 'sample-project', createdAt: 0, activeTreeId: 't1', chatIds: ['a'], edges: [],
    trees: [{ id: 't1', rootNodeId: 'a', createdAt: 0, lastActiveAt: 10 }] },
] as unknown as Project[];
const nodes: Record<string, ChatNodeState> = {
  a: { nodeId: 'a', chatId: null, projectId: 'p1', kind: 'chat', title: 'a', messages: [], followUps: [], status: 'idle' } as ChatNodeState,
};
vi.mock('../../../state/chatStore', async () => ({
  ...(await vi.importActual<object>('../../../state/chatStore')),
  useChatStore: () => ({
    projects, activeProject: projects[0], activeProjectId: 'p1', hydrated: true, selectProject: vi.fn(), enterChatsWorkspace: vi.fn(),
  }),
  useStructuralSelector: (selector: (n: Record<string, ChatNodeState>) => unknown) => selector(nodes),
}));

function card(id: string): HomeCard {
  return { id, kind: 'continue', label: 'Continue', source: { workspaceId: 'p1' }, title: `Title ${id}`, reason: `Reason ${id}`,
    buttonText: 'Continue', prompt: `Prompt ${id}`, workspaceId: 'p1' };
}
function answer(extra: Partial<HomeCardsDto> = {}): HomeCardsDto {
  return {
    greeting: { text: 'Good morning.', detail: 'Three threads moved overnight.' },
    sets: [{ cards: Array.from({ length: 6 }, (_, i) => card(`a${i}`)) }],
    generatedAt: 1, inputFingerprint: 'fp', ...extra,
  };
}

const lastComposerProps = () => composer.props.mock.calls.at(-1)?.[0];
const DETAIL = 'Michi won’t use your memories, and other chats can’t read this one. It stays in your history. This can’t be changed after you send.';

async function renderHome() {
  const view = render(<TerminalHome onSubmitted={() => {}} />);
  await waitFor(() => expect(api.fetchHomeCards).toHaveBeenCalled());
  await act(async () => {});
  return view;
}

describe('Home with its temporary-chat switch on', () => {
  beforeEach(() => {
    composer.props.mockClear();
    composer.mounts = 0;
    api.fetchHomeCards.mockReset().mockResolvedValue(answer());
    api.markHomeCardUsed.mockReset().mockResolvedValue(undefined);
    __resetHomeCardsCacheForTests();
    act(() => resetTemporaryChatDraft());
  });
  afterEach(() => { cleanup(); act(() => resetTemporaryChatDraft()); });

  it('says what the chat will and won’t do instead of the greeting, and hides the cards', async () => {
    act(() => setTemporaryChatDraft(true));
    await renderHome();
    const eyebrow = document.querySelector('.michi-home-eyebrow')!;
    expect(eyebrow.textContent).toBe('Temporary chat');
    expect(eyebrow.querySelector('[data-temporary-chat-mark]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('_ Nothing here goes into memory.');
    expect(screen.getByText(DETAIL)).toBeTruthy();
    expect(screen.queryAllByTestId('home-card')).toHaveLength(0);
    expect(screen.queryAllByTestId('home-recent')).toHaveLength(0);
    expect(screen.queryByText(/^Good (morning|afternoon|evening)/)).toBeNull();
    // Nothing under the composer, not even the cards' loading placeholders.
    expect(document.querySelector('.home-below')?.childElementCount).toBe(0);
    expect(lastComposerProps()?.temporary).toBe(true);
  });

  it('hides Home’s own page too', async () => {
    api.fetchHomeCards.mockResolvedValue(answer({ greeting: null, contentMode: 'page', contentPage: { id: 'home', title: 'My home layout' } as never }));
    act(() => setTemporaryChatDraft(true));
    await renderHome();
    expect(screen.queryByRole('region', { name: 'Home content' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('_ Nothing here goes into memory.');
  });

  it('switches back and forth with the same composer, so a draft stays', async () => {
    await renderHome();
    // Direction B (Q44): the time of day and Jump back in.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/^_ Good (morning|afternoon|evening)$/);
    expect(screen.queryAllByTestId('home-recent')).toHaveLength(1);
    expect(lastComposerProps()?.temporary).toBe(false);
    const input = screen.getByTestId('composer');

    act(() => setTemporaryChatDraft(true));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('_ Nothing here goes into memory.');
    expect(screen.queryAllByTestId('home-recent')).toHaveLength(0);
    expect(screen.getByTestId('composer')).toBe(input);
    expect(input.getAttribute('data-temporary')).toBe('true');

    act(() => setTemporaryChatDraft(false));
    expect(screen.queryAllByTestId('home-recent')).toHaveLength(1);
    expect(screen.queryByText(DETAIL)).toBeNull();
    expect(screen.getByTestId('composer')).toBe(input);
    expect(composer.mounts).toBe(1);
  });
});
