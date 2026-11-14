import React, { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { HomeCard } from 'michi-shared';
import { CHATS_WORKSPACE_ID, useChatStore, useStructuralSelector } from '../../../state/chatStore';
import type { ChatNodeState } from '../../../state/chatTypes';
import ManageComposer, { type ManageComposerHandle } from '../manage/ManageComposer';
import { HomeWorkspaceChip } from '../HomeWorkspaceChip';
import { useMinuteClock } from '../content/home/useMinuteClock';
import { isSystemWorkspace } from '../../../state/assistant/systemWorkspace';
import { isListedThread } from '../../../state/conversationVisibility';
import { useReturnFromSystemWorkspace } from '../../../state/assistant/userWorkspace';
import { entryPageForArea } from '../../../state/shellArea';
import { useHomeCards } from '../../../state/homeCards/useHomeCards';
import { HomeGreeting, TemporaryChatGreeting } from '../home/HomeGreeting';
import { HomeCardGrid, HomeCardGridSkeleton } from '../home/HomeCards';
import { useHomeRecommendations } from '../../../state/prefs';
import { ONBOARDING_CARDS } from '../home/onboardingCards';
import { HomeRecent } from '../home/HomeRecent';
import { HomeWorkStrip } from '../home/HomeWorkStrip';
import { navPageEvent } from '../../../state/appEvents';
import { useBackendScope } from '../../../hooks/useBackendScope';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendConnections';
import { companionIsOff, useCompanion } from '../../../state/companion/companionStore';
import { useCompanionName } from '../../../state/companion/companionName';
import { openCompanionPanel } from '../../../state/companion/companionPanel';
import { homeGreetingText } from '../../../state/home/homeGreeting';
import { selectHomeRecent, type HomeRecentThread } from '../../../state/home/homeRecent';
import { homeWorkCounts } from '../../../state/home/homeWork';
import { useTemporaryChatDraft } from '../../../state/temporaryChatDraft';

const ChatHomeDocument = lazy(() => import('../home/ChatHomeDocument'));

interface HomeProps {
  onSubmitted: () => void;
}

/** Where Home's larger chips stop fitting on one toolbar row, with a typical
 *  workspace name and model: first the chips drop their text, then the agent
 *  chip goes. Measured on the toolbar's border box. */
const HOME_TOOLBAR_COMPACTION = { glyphsBelow: 640, hideAgentBelow: 480 };
/** Below this toolbar width one row cannot also hold the workspace and
 *  permission chips (a phone, or a narrow pane), so they move to a tray
 *  under the composer and the toolbar keeps one row. */
const HOME_TRAY_BELOW = 480;
/** How long content that arrived after the placeholders keeps its entrance
 *  (homeCards.css): the last card's delay plus its fade, with room to spare. */
const HOME_ARRIVAL_MS = 1000;

function openSpacesHome() {
  navPageEvent.dispatch({ page: entryPageForArea('spaces', 'home') });
}

const sameRecent = (a: readonly HomeRecentThread[], b: readonly HomeRecentThread[]) => a.length === b.length
  && a.every((thread, index) => {
    const other = b[index]!;
    return thread.treeId === other.treeId && thread.projectId === other.projectId && thread.title === other.title && thread.workspaceName === other.workspaceName
      && thread.overview === other.overview && thread.running === other.running && thread.unread === other.unread
      && thread.startedByMichi === other.startedByMichi && thread.at === other.at;
  });

export default function TerminalHome({ onSubmitted }: HomeProps) {
  const { activeProject, projects, selectProject, hydrated, enterChatsWorkspace, activateTree } = useChatStore();

  const liveProjects = useMemo(
    () => projects.filter((p) => !p.deletedAt && !p.archivedAt && !isSystemWorkspace(p)),
    [projects],
  );
  // Opening the assistant as a pane makes its hidden workspace the active
  // one. Home starts threads in the active workspace, so it moves back to one
  // of the user's — a thread started here must never land out of sight.
  const homeProject = activeProject && !isSystemWorkspace(activeProject) ? activeProject : null;
  useReturnFromSystemWorkspace(true, activeProject, projects, selectProject);
  // The chip presents the folder-less Chats workspace as "no workspace", the
  // state its × leads to, rather than as one more workspace to pick.
  const chipProjects = useMemo(() => liveProjects.filter((p) => p.id !== CHATS_WORKSPACE_ID), [liveProjects]);
  const chipActive = homeProject?.id === CHATS_WORKSPACE_ID ? null : homeProject;

  const hasConversationSelector = useCallback(
    (nodesMap: Record<string, ChatNodeState>) => liveProjects.some((p) => p.trees.some((t) => isListedThread(t, nodesMap[t.rootNodeId]))),
    [liveProjects],
  );
  const hasConversation = useStructuralSelector(hasConversationSelector);
  const { cards: homeCards, loaded, markUsed } = useHomeCards();
  const clock = useMinuteClock(true);

  // Michi on (Q44, Q47): on this computer's backend, with its snapshot, not paused. A remote counts as off.
  const companion = useCompanion();
  const name = useCompanionName();
  const local = useBackendScope().connectionId === LOCAL_BACKEND_CONNECTION_ID;
  const michiOn = local && companion.availability === 'available' && !!companion.snapshot && !companionIsOff(companion);
  const delegations = companion.snapshot?.delegations;
  const michiStarted = useMemo(() => new Set((delegations ?? []).map((delegation) => delegation.nodeId)), [delegations]);
  const recentSelector = useCallback(
    (nodesMap: Record<string, ChatNodeState>) => selectHomeRecent(liveProjects, nodesMap, { michiStarted }),
    [liveProjects, michiStarted],
  );
  const recent = useStructuralSelector(recentSelector, sameRecent);
  const openThread = useCallback((thread: HomeRecentThread) => {
    if (thread.projectId !== homeProject?.id) selectProject(thread.projectId);
    activateTree(thread.treeId, thread.projectId);
    navPageEvent.dispatch({ page: 'dashboard' });
  }, [homeProject?.id, selectProject, activateTree]);
  const [setIndex, setSetIndex] = useState(0);
  // The topbar's switch: the chat this Home starts next is temporary.
  const temporary = useTemporaryChatDraft();

  // The clock and the cards re-render Home; the composer doesn't need to follow.
  const onSubmittedRef = useRef(onSubmitted);
  onSubmittedRef.current = onSubmitted;
  const handleSubmitted = useCallback(() => onSubmittedRef.current(), []);
  const composerRef = useRef<ManageComposerHandle>(null);
  const composer = useMemo(() => (
    // Override the shared composer typography vars only on Home, so the
    // input feels like a hero element without bloating chat bubbles or
    // the workspace-page composer. MentionEditor reads both vars at
    // render time, so cascading from this wrapper is enough — no prop
    // plumbing into ManageComposer required.
    <div
      style={{
        ['--message-body-size' as string]: '17px',
        ['--message-body-leading' as string]: '1.55',
        // Open with two lines so a card's prompt doesn't start out cramped;
        // it still grows to the shared max-height cap.
        ['--composer-min-rows' as string]: '2',
        ['--composer-chrome-size' as string]: 'var(--fs-lg)',
        // Hero chips: bigger font, but tighter horizontal padding and
        // letter-spacing so the row stays compact rather than sprawling.
        // Icon-only chips track --composer-chip-height for square sizing.
        ['--composer-chip-size' as string]: 'var(--fs-lg)',
        ['--composer-chip-height' as string]: '30px',
        ['--composer-chip-h-pad' as string]: '8px',
        ['--composer-chip-gap' as string]: '5px',
        ['--composer-chip-tracking' as string]: '0',
      } as React.CSSProperties}
    >
      <ManageComposer
        ref={composerRef}
        onSubmitted={handleSubmitted}
        temporary={temporary}
        enableAgentSelect
        toolbarCompaction={HOME_TOOLBAR_COMPACTION}
        trayBelow={HOME_TRAY_BELOW}
        toolbarLeftPrefix={
          <HomeWorkspaceChip
            active={chipActive}
            liveProjects={chipProjects}
            onSelect={selectProject}
            onNewWorkspace={() =>
              window.dispatchEvent(new CustomEvent('michi:open-new-workspace'))
            }
            onClear={() => { void enterChatsWorkspace(); }}
          />
        }
      />
    </div>
  ), [handleSubmitted, temporary, chipActive, chipProjects, selectProject, enterChatsWorkspace]);

  const fill = useCallback((text: string) => { composerRef.current?.insert(text); }, []);

  const recommendations = useHomeRecommendations();
  // Until the first answer, Home shows where its greeting and cards will be.
  const pending = recommendations && !loaded;
  // What arrives after the placeholders fades in; a remembered answer shows at once.
  const [arriving, setArriving] = useState(false);
  const wasPending = useRef(pending);
  useLayoutEffect(() => {
    const arrived = wasPending.current && !pending;
    wasPending.current = pending;
    if (!arrived) return;
    setArriving(true);
    const timer = window.setTimeout(() => setArriving(false), HOME_ARRIVAL_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);
  const contentMode = recommendations ? homeCards.contentMode ?? 'default' : 'default';
  // Only the cards the user chose (edit_home): what Pages upkeep wrote before the unification stays unread (D13).
  const sets = homeCards.cardsCustomized ? homeCards.sets : [];
  const shownSet = sets.length > 0 ? sets[setIndex % sets.length]! : null;
  const pickCard = (card: HomeCard) => {
    if (card.workspaceId && card.workspaceId !== homeProject?.id && liveProjects.some((p) => p.id === card.workspaceId)) {
      selectProject(card.workspaceId);
    }
    fill(card.prompt);
    markUsed(card);
  };

  // A new user gets the getting-started cards; otherwise the cards the user chose, or Michi's work and the latest conversations.
  const onboarding = loaded && hydrated && !hasConversation && !homeCards.cardsCustomized;
  let grid: React.ReactNode = null;
  if (onboarding) {
    grid = (
      <HomeCardGrid
        cards={ONBOARDING_CARDS}
        canShuffle={false}
        onShuffle={() => {}}
        onOpenSpacesHome={openSpacesHome}
        onPick={(id) => {
          const action = ONBOARDING_CARDS.find((card) => card.id === id)?.action;
          if (action?.type === 'compose') fill(action.prompt);
          else if (action?.type === 'mention') composerRef.current?.startMention();
          else if (action?.type === 'spaces') openSpacesHome();
        }}
      />
    );
  } else if (homeCards.cardsCustomized) {
    if (shownSet) grid = (
      <HomeCardGrid
        cards={shownSet.cards}
        canShuffle={sets.length > 1}
        onShuffle={() => setSetIndex((index) => (index + 1) % sets.length)}
        onOpenSpacesHome={openSpacesHome}
        onPick={(id) => {
          const card = shownSet.cards.find((entry) => entry.id === id);
          if (card) pickCard(card);
        }}
      />
    );
  } else if (loaded && hydrated) {
    // Direction B (Q44): Michi's work in one line while it is on, then the latest conversations.
    grid = (
      <div className="home-default">
        {michiOn && companion.snapshot && (
          <HomeWorkStrip name={name} counts={homeWorkCounts(companion.snapshot, clock)} onOpenToday={() => openCompanionPanel({ tab: 'today' })} />
        )}
        {recent.length > 0 && <HomeRecent threads={recent} now={clock} name={name} onOpen={openThread} />}
      </div>
    );
  }

  // The original hero when Home shows no recommendations (nothing pending then, and no content of
  // its own). The composer stays in the same position in the React tree so loading cannot lose a
  // draft, and the head above it keeps one height so it stays in place on screen too. A temporary
  // chat's Home says what that chat will and won't do instead, with nothing under the composer.
  const defaultLayout = !temporary && !recommendations;
  // The greeting the user chose (edit_home) stands; otherwise Q45: Michi's latest line while it is on, else the time of day.
  const greeting = homeCards.greetingCustomized ? homeCards.greeting
    : { text: homeGreetingText(clock, michiOn ? companion.snapshot?.headline ?? null : null), detail: null };

  return (
    <div
      className="home-scroll"
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        fontFamily: 'var(--ui-font)',
        color: 'var(--term-fg)',
        background: 'var(--term-page-bg, var(--term-bg))',
      }}
    >
      <div className="home-page" aria-busy={pending || undefined} data-arriving={arriving || undefined}>
        <div className="home-head">
          {temporary ? <TemporaryChatGreeting /> : defaultLayout ? (
            <h1 className="home-default-headline">
              <span className="michi-home-headline__mark">_ </span>
              Another road diverged in a yellow wood.
            </h1>
          ) : <HomeGreeting greeting={greeting} now={clock} pending={pending} />}
        </div>
        <div className="home-compose">
          {composer}
        </div>
        {/* The placeholders fade out under what replaces them. */}
        <div className="home-below">
          {!temporary && (pending || arriving) && <HomeCardGridSkeleton count={3} leaving={!pending} />}
          {temporary || pending ? null : contentMode === 'default' ? (recommendations ? grid : null) : contentMode === 'page' ? (
            homeCards.contentPage ? <Suspense fallback={<p role="status">Loading Home content…</p>}>
              <ChatHomeDocument key={homeCards.contentPage.id} page={homeCards.contentPage} />
            </Suspense> : <p role="status">Your Home page is unavailable. Ask the agent to choose another page or restore the default Home.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
