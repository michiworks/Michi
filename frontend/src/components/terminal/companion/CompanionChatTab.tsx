import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendIdentity';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { companionPostRunId, type CompanionCardDto, type CompanionPostMetadata } from 'michi-shared';
import TPane from '../TPane';
import { Button } from '../../ui/controls';
import { AssistantLinkChip, AssistantLinkScope } from '../assistant/AssistantLinks';
import { MarkdownLinkRendererContext, type MarkdownLinkRenderer } from '../../markdownLinkRenderer';
import {
  chatLabel,
  useChatActions,
  useChatNodeReader,
  useChatPanes,
  useChatProjects,
  useOptionalChatProjects,
  useStructuralSelector,
} from '../../../state/chatStore';
import type { ChatMessage, ChatNodeState, ComposerDraft, NarrationOption } from '../../../state/chatTypes';
import type { PageId } from '../../../state/commands';
import { MetaChatDecorationsContext, type MetaChatDecorations } from '../../../state/metaChat/metaChatDecorations';
import { metaAgentToolLine } from '../../../state/metaChat/toolLines';
import { getSpacesHomeIds, knownSpacesPages } from '../../../state/metaChat/spacesPages';
import { SPACES_SUGGESTIONS, visibleSuggestions, type MetaChatSuggestion } from '../../../state/metaChat/suggestions';
import type { AssistantInfo } from '../../../services/api/assistant';
import { viewPageId } from '../../../state/metaChat/turnContext';
import { parseAssistantLink, type AssistantLink } from '../../../state/assistant/assistantLinks';
import { useAssistantNode } from '../../../state/assistant/useAssistantNode';
import {
  addAssistantAttachments,
  dismissAssistantPage,
  injectedAssistantDraftIsStale,
  isUntouchedInjectedDraft,
  noteAssistantDraftInjected,
  pendingAssistantPage,
  requestAssistantSend,
  setAssistantPage,
  takeInjectedAssistantDraft,
  useAssistantComposer,
} from '../../../state/assistant/assistantComposer';
import { assistantPageCaption, assistantPageKey, type AssistantPageView } from '../../../state/assistant/assistantContext';
import {
  CompanionApiError,
  applyCompanionCard,
  dismissCompanionCard,
  undoCompanionRun,
  type CompanionSnapshot,
} from '../../../services/api/companion';
import {
  companionAssistantSource,
  getCompanionState,
  loadCompanionAssistant,
  scheduleCompanionRefresh,
  updateCompanionSnapshot,
  useCompanion,
  useCompanionAssistant,
  wantCompanionWelcome,
} from '../../../state/companion/companionStore';
import {
  dropCompanionRequests,
  getCompanionPanelState,
  openCompanionSource,
  setCompanionPanelTab,
  setCompanionTarget,
  subscribeCompanionPanel,
  takeCompanionFocusMessage,
  takeCompanionRequests,
  useCompanionPanel,
} from '../../../state/companion/companionPanel';
import { useCompanionName } from '../../../state/companion/companionName';
import { noteCompanionComposing } from '../../../state/companion/companionPresence';
import { useCompanionSpacesScreen } from '../../../state/companion/companionScreen';
import { noteCompanionPostReply } from '../../../state/companion/companionReply';
import { spacesSupportsConnection } from '../../../state/metaAgent/remoteSpaces';
import { backendConnectionIdForWorkspace } from '../../../config/backendConnections';
import { fetchWindowConversation } from '../../../state/metaChat/firstRunWindow';
import { openConversationFromSpaces } from '../../../state/sourceNav/sourceNav';
import { MetaChatCards, type MetaChatCardsContext } from '../spaces/metaChat/MetaChatCards';
import { MetaChatSuggestions } from '../spaces/metaChat/MetaChatSuggestions';
import { useLayoutRules } from '../spaces/layoutRules/useLayoutRules';
import {
  companionCardPreview,
  companionHiddenCharacterCount,
  companionHiddenCharacters,
  type CompanionCardContext,
  type CompanionCardPart,
} from '../../../state/companion/companionCards';
import { CompanionVisibleText } from './CompanionVisibleText';
import { companionItemUrls, companionLinkVerdict } from '../../../state/companion/companionLinks';
import { companionToolLine, companionWorkLine, type CompanionToolLineNames } from '../../../state/companion/companionToolLines';
import { itemsInBucket } from '../../../state/companion/companionView';

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

/**
 * Links in the agent's posts (DESIGN R2.1): `michi://` as chips, the work
 * sites it watches and its items' own targets as links, anything else (a
 * link out of an email preview, a worker reply) as plain text. Nothing in it
 * loads on its own: an image (Markdown, raw HTML, a picture, video or frame)
 * shows as its alt text, so a reply cannot make the window fetch an address
 * it names (answers, thoughts and streaming blocks alike).
 */
export function companionLinkRenderer(itemUrls: ReadonlySet<string>, name: string): MarkdownLinkRenderer {
  return {
    protocols: ['michi'],
    matches: (href) => href.trim() !== '',
    render: (href, children) => {
      const verdict = companionLinkVerdict(href, itemUrls);
      if (verdict.kind === 'michi') return <MichiLink link={verdict.link}>{children}</MichiLink>;
      if (verdict.kind === 'web') return <a href={verdict.url} target="_blank" rel="noopener noreferrer">{children}</a>;
      return <span className="companion-link-text" title={`Not one of the sites ${name} watches`}>{children}</span>;
    },
    remoteMedia: false,
  };
}

function upsertCard(cards: readonly CompanionCardDto[], next: CompanionCardDto): CompanionCardDto[] {
  return cards.map((card) => (card.id === next.id ? next : card));
}

function CardPart({ part }: { part: CompanionCardPart }) {
  switch (part.kind) {
    case 'lead':
      return <p className="companion-card__lead"><CompanionVisibleText text={part.text} /></p>;
    case 'note':
      return <p className="companion-card__note"><CompanionVisibleText text={part.text} /></p>;
    case 'text':
      return (
        <div className="companion-card__block">
          {part.label && <div className="companion-card__label">{part.label}</div>}
          <div className="companion-card__text"><CompanionVisibleText text={part.text} /></div>
        </div>
      );
    case 'fields':
      return (
        <dl className="companion-card__fields">
          {part.rows.map((row) => (
            <React.Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd><CompanionVisibleText text={row.value} /></dd>
            </React.Fragment>
          ))}
        </dl>
      );
    case 'diff':
      return (
        <div className="companion-card__diff">
          {part.lines.map((line, index) => (
            <div key={index} className="companion-card__diff-line" data-change={line.change}>
              <span className="companion-card__diff-mark" aria-hidden="true">{line.change === 'added' ? '+' : line.change === 'removed' ? '−' : ' '}</span>
              {line.change !== 'same' && <span className="sr-only">{line.change === 'added' ? 'Added: ' : 'Removed: '}</span>}
              <CompanionVisibleText text={line.text || ' '} />
            </div>
          ))}
        </div>
      );
  }
}

/**
 * One proposal: Michi's summary, then everything Apply will do from the card's
 * own payload (a conversation's whole first message, the rules before and
 * after, a reminder's time and item), then the Companion's reason, labelled
 * as its words. A change too long for its box enables Apply once the box was
 * scrolled to the end, so nothing is approved unseen.
 */
function ProposalCard({ card, context, speaker, busy, onDecide }: {
  card: CompanionCardDto;
  context: CompanionCardContext;
  speaker: string;
  busy: boolean;
  onDecide(card: CompanionCardDto, decision: 'apply' | 'dismiss'): void;
}) {
  const preview = useMemo(() => companionCardPreview(card, context), [card, context]);
  const hidden = useMemo(
    () => companionHiddenCharacterCount(preview) + companionHiddenCharacters(card.summary) + companionHiddenCharacters(card.reason ?? '') > 0,
    [card.reason, card.summary, preview],
  );
  const detailsRef = useRef<HTMLDivElement>(null);
  const [readAll, setReadAll] = useState(false);
  const check = useCallback(() => {
    const box = detailsRef.current;
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight <= 4) setReadAll(true);
  }, []);
  useLayoutEffect(() => {
    check();
    const box = detailsRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(box);
    return () => observer.disconnect();
  }, [check, preview]);
  return (
    <div className="companion-card" role="group" aria-label={card.summary}>
      <div className="companion-card__summary"><CompanionVisibleText text={card.summary} /></div>
      {hidden && (
        <p className="companion-card__warn">
          Some characters here don’t show on screen; they are marked ⟨hidden character⟩. Whatever reads this text still
          gets them, so dismiss it unless you know why they are there.
        </p>
      )}
      <div ref={detailsRef} className="companion-card__details" role="region" aria-label={`What ${preview.applyLabel} does`} tabIndex={0} onScroll={check}>
        {preview.parts.map((part, index) => <CardPart key={index} part={part} />)}
      </div>
      {card.reason && (
        <div className="companion-card__reason">
          <span className="companion-card__label">{speaker}’s reason:</span> <CompanionVisibleText text={card.reason} />
        </div>
      )}
      <div className="companion-card__actions">
        <Button size="sm" variant="primary" disabled={busy || !readAll} onClick={() => onDecide(card, 'apply')}>{preview.applyLabel}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(card, 'dismiss')}>Dismiss</Button>
        {!readAll && <span className="companion-card__hint">Scroll to the end to enable {preview.applyLabel}</span>}
      </div>
    </div>
  );
}

/** The changes the Companion proposed, each with Apply and Dismiss (only the user's click changes anything). */
function CardStrip({ cards, snapshot }: { cards: readonly CompanionCardDto[]; snapshot: CompanionSnapshot }) {
  const [busy, setBusy] = useState<string | null>(null);
  const projects = useOptionalChatProjects()?.projects;
  const { goals, items, rules, settings } = snapshot;
  const context = useMemo<CompanionCardContext>(() => ({
    goals, items, rules, settings,
    workspaceName: (id) => projects?.find((project) => project.id === id)?.name ?? null,
  }), [goals, items, projects, rules, settings]);
  const decide = async (card: CompanionCardDto, decision: 'apply' | 'dismiss') => {
    setBusy(card.id);
    try {
      const next = await (decision === 'apply' ? applyCompanionCard(card.id) : dismissCompanionCard(card.id));
      updateCompanionSnapshot((snapshot) => ({ ...snapshot, cards: upsertCard(snapshot.cards, next) }));
      if (next.status === 'failed') toast.error(`Couldn’t apply it: ${next.error ?? 'the change no longer fits'}`);
    } catch (error) {
      if (error instanceof CompanionApiError && error.code === 'companion_busy') {
        // Refused for now (409 companion_busy, no card: a follow-up whose conversation is still working,
        // DESIGN-v2 §4). Not an error: the card stays pending as it is and can be sent again.
        toast(`Not sent yet: ${error.message}`);
      } else if (error instanceof CompanionApiError && error.card) {
        const card = error.card;
        updateCompanionSnapshot((snapshot) => ({ ...snapshot, cards: upsertCard(snapshot.cards, card) }));
        toast(error.code === 'card_expired' ? 'That suggestion expired' : `That suggestion was already ${card.status}`);
      } else {
        toast.error(`Couldn’t ${decision} it: ${errorText(error)}`);
      }
    } finally {
      setBusy(null);
      scheduleCompanionRefresh();
    }
  };
  return (
    <>
      {cards.map((card) => (
        <ProposalCard key={card.id} card={card} context={context} speaker={settings.displayName} busy={busy === card.id}
          onDecide={(target, decision) => { void decide(target, decision); }} />
      ))}
    </>
  );
}

/**
 * A `michi://` link in the panel: the area on screen may show a conversation
 * its own way (Pages: the source popover over the page, DESIGN-v2 §1.4); the
 * chip opens it otherwise.
 */
function MichiLink({ link, children }: { link: AssistantLink; children: React.ReactNode }) {
  return (
    <span
      className="companion-source-link"
      onClickCapture={(event) => {
        if (!openCompanionSource(link)) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <AssistantLinkChip link={link}>{children}</AssistantLinkChip>
    </span>
  );
}

/**
 * Links in the agent's replies to the user (DESIGN-v2 §2.8): `michi://` as
 * chips, everything else as ordinary links; nothing loads on its own.
 */
const COMPANION_REPLY_LINKS: MarkdownLinkRenderer = {
  protocols: ['michi'],
  matches: (href) => parseAssistantLink(href) !== null,
  render: (href, children) => {
    const link = parseAssistantLink(href);
    return link ? <MichiLink link={link}>{children}</MichiLink> : children;
  },
  remoteMedia: false,
};

/** A check-in's post (DESIGN-v2 §3.3): live by its metadata, before that by its `cmp-post-` id. */
function companionPostOf(message: ChatMessage): CompanionPostMetadata | null {
  if (message.role !== 'assistant') return null;
  if (message.companionPost) return message.companionPost;
  const runId = companionPostRunId(message.id);
  return runId ? { runId, kind: 'heartbeat', changes: [] } : null;
}

/** The Pages upkeep's first-run narration, posted into the same conversation (`mna-` turns). */
const isNarration = (message: ChatMessage) => message.role === 'assistant' && message.id.startsWith('mna-');

type OpenOption = NonNullable<NarrationOption['open']>;
const NO_OPEN_OPTIONS: ReadonlyMap<string, OpenOption> = new Map();
const NO_SUGGESTIONS: readonly MetaChatSuggestion[] = [];

/**
 * The options of the first run's closing question that continue in another
 * conversation, by label (F1a-review #5). A reloaded message has them from its
 * stored metadata; a live post's frames carry only the chips' labels, so the
 * stored row is read once, when the narration that ends V is in.
 */
function useNarrationOpenOptions(info: AssistantInfo | null, busy: boolean): ReadonlyMap<string, OpenOption> {
  const nodeId = info?.nodeId ?? null;
  const workspaceId = info?.workspaceId;
  const treeId = info?.treeId;
  const last = useStructuralSelector(useCallback((nodes: Record<string, ChatNodeState>) => {
    const message = nodeId ? nodes[nodeId]?.messages.at(-1) : undefined;
    return message && isNarration(message) ? message : null;
  }, [nodeId]));
  const lastId = last?.id ?? null;
  const stored = last?.narrationOptions;
  const [fetched, setFetched] = useState<{ id: string; options: readonly NarrationOption[] } | null>(null);
  const askedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!lastId || stored || busy || !nodeId || !workspaceId || !treeId || askedFor.current === lastId) return undefined;
    askedFor.current = lastId;
    const controller = new AbortController();
    fetchWindowConversation({ workspaceId, treeId, nodeId }, controller.signal).then((conversation) => {
      if (!controller.signal.aborted && conversation.messages.at(-1)?.id === lastId) setFetched({ id: lastId, options: conversation.options });
    }, () => { if (askedFor.current === lastId) askedFor.current = null; });
    return () => {
      controller.abort();
      if (askedFor.current === lastId) askedFor.current = null;
    };
  }, [lastId, stored, busy, nodeId, workspaceId, treeId]);
  return useMemo(() => {
    const options = stored ?? (fetched && fetched.id === lastId ? fetched.options : []);
    const open = options.filter((option): option is NarrationOption & { open: OpenOption } => !!option.open);
    return open.length ? new Map(open.map((option) => [option.label, option.open])) : NO_OPEN_OPTIONS;
  }, [stored, fetched, lastId]);
}

const POST_LABELS: Partial<Record<CompanionPostMetadata['kind'], string>> = {
  heartbeat: 'check-in',
  wake: 'check-in',
  catch_up: 'check-in',
  brief: 'morning brief',
  worker_report: 'worker update',
};

/** "<name> · check-in" ("morning brief", "worker update" by kind; the welcome is just the name), §1.5, §3.3. */
export function companionSpeaker(name: string, message: ChatMessage): string {
  if (isNarration(message)) return `${name} · first look`;
  const post = companionPostOf(message);
  if (!post) return name;
  const label = message.companionPost ? POST_LABELS[post.kind] : 'check-in';
  return label ? `${name} · ${label}` : name;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ITEM_ACTIONS: Record<string, string> = { snooze: 'Snoozed', dismiss: 'Dismissed', restore: 'Restored' };
const GOAL_ACTIONS: Record<string, string> = { add: 'Added', reword: 'Reworded', remove: 'Removed' };

/**
 * The receipt under a post that changed something (DESIGN-v2 §3.3, §2.7): each
 * page, database, Today item and goal it touched, with "Undo all". A title is
 * only one that existed before the check-in; reasons are its words, shown as
 * plain text.
 */
function CompanionReceipt({ post, name }: { post: CompanionPostMetadata; name: string }) {
  // Read here, not handed down: the titles and "Undone" follow each snapshot (an undo from Activity
  // or another window) without the conversation re-rendering (F1a-review #12).
  const { snapshot } = useCompanion();
  const [busy, setBusy] = useState(false);
  const run = snapshot?.activity.find((entry) => entry.id === post.runId);
  const [undone, setUndone] = useState(false);
  if (post.changes.length === 0) return null;
  const titleOf = (id: string) => snapshot?.checkinChanges?.find((change) => change.targetId === id && change.runId === post.runId)?.title
    ?? snapshot?.items.find((item) => item.id === id)?.title ?? null;
  const lines = post.changes.map((change, index) => {
    let text: string;
    if (change.kind === 'page' || change.kind === 'database') {
      const counts = [change.applied ? plural(change.applied, 'change') : null, change.proposed ? `${plural(change.proposed, 'proposal')} to review` : null]
        .filter(Boolean).join(', ');
      text = `${change.title ?? (change.kind === 'page' ? 'A new page' : 'A new database')}${counts ? `: ${counts}` : ''}`;
    } else if (change.kind === 'item') {
      const title = titleOf(change.id);
      text = `${ITEM_ACTIONS[change.action ?? ''] ?? 'Changed'} ${title ? `“${title}”` : 'an item'} on Today`;
    } else if (change.kind === 'send') {
      // A follow-up the check-in sent itself (D21): it went out, so "Undo all" cannot take it back.
      text = `Sent a follow-up to ${change.title ? `“${change.title}”` : 'a conversation'}`;
    } else {
      text = `${GOAL_ACTIONS[change.action ?? ''] ?? 'Changed'} a goal`;
    }
    return (
      <li key={`${change.kind}:${change.id}:${index}`} className="companion-receipt__line">
        <CompanionVisibleText text={text} />
        {change.reason && <span className="companion-receipt__reason"> — <CompanionVisibleText text={change.reason} /></span>}
      </li>
    );
  });
  const isUndone = undone || !!run?.undoneAt;
  // Only sends: nothing "Undo all" could take back, so no button (the backend answers a send as not undoable).
  const undoable = post.changes.some((change) => change.kind !== 'send');
  const undoAll = async () => {
    setBusy(true);
    try {
      const result = await undoCompanionRun(post.runId);
      if (result.conflicts.length > 0) toast.error(`Undid ${plural(result.reverted.length, 'change')}; ${result.conflicts[0].message}`);
      else {
        setUndone(true);
        toast(`Undid what ${name} changed`);
      }
    } catch (error) {
      toast.error(`Couldn’t undo it: ${errorText(error)}`);
    } finally {
      setBusy(false);
      scheduleCompanionRefresh();
    }
  };
  return (
    <div className="companion-receipt" role="group" aria-label={`What ${name} changed`}>
      <ul className="companion-receipt__lines">{lines}</ul>
      {undoable && (
        <div className="companion-receipt__actions">
          {isUndone
            ? <span className="companion-receipt__done">Undone</span>
            : <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void undoAll(); }}>Undo all</Button>}
        </div>
      )}
    </div>
  );
}

/** The lines under a user message the route decided something about (DESIGN-v2 §1.3, §2.8 T4). */
function CompanionTurnNotes({ message, name }: { message: ChatMessage; name: string }) {
  const turn = message.role === 'user' ? message.companionTurn : undefined;
  if (!turn) return null;
  return (
    <div className="companion-turn-notes">
      {turn.rulesUnavailable && <p className="companion-turn-note" role="note">{name} couldn’t read your rules, so it won’t act on its own this turn.</p>}
      {turn.startTaint && <p className="companion-turn-note" role="note">Tools ask before running this turn: it includes check-in material.</p>}
      {!turn.startTaint && turn.carriedTaint && (
        <p className="companion-turn-note" role="note">Tools ask before running this turn: this conversation read check-in material earlier.</p>
      )}
    </div>
  );
}

function samePageView(a: AssistantPageView | null, b: AssistantPageView | null): boolean {
  return (a?.kind ?? null) === (b?.kind ?? null) && (a?.projectId ?? null) === (b?.projectId ?? null)
    && (a?.nodeId ?? null) === (b?.nodeId ?? null) && (a?.title ?? null) === (b?.title ?? null);
}

/** What the user is looking at outside Pages, named for the "On screen: …" chip (the ⌘J card's behaviour). */
function useLivePage(page: PageId | undefined, assistantNodeId: string | null): AssistantPageView {
  const { focusedPane, openPanes } = useChatPanes();
  const { projects, activeProjectId } = useChatProjects();
  const activeTreeId = projects.find((p) => p.id === activeProjectId)?.activeTreeId;
  const onGrid = page === 'dashboard' || (page === undefined && !!focusedPane);
  const gridShowsHome = onGrid && openPanes.length === 0 && activeTreeId != null;
  const paneTitle = useStructuralSelector(useCallback((nodes: Record<string, ChatNodeState>) => {
    const node = focusedPane ? nodes[focusedPane] : undefined;
    return node ? node.title || chatLabel(node) : null;
  }, [focusedPane]));
  const view: AssistantPageView = (() => {
    if (page === 'home') return { kind: 'home' };
    if (page === 'threads') return { kind: 'threads' };
    if (!onGrid) return { kind: 'other' };
    if (gridShowsHome) return { kind: 'home' };
    if (!focusedPane || paneTitle === null || focusedPane === assistantNodeId) return { kind: 'other' };
    return { kind: 'pane', nodeId: focusedPane, title: paneTitle };
  })();
  const stable = useRef(view);
  if (!samePageView(stable.current, view)) stable.current = view;
  return stable.current;
}

type SetComposerDraft = (nodeId: string, draft: ComposerDraft | null) => void;

/**
 * A prompt a caller put in the composer is cleared once its moment is over
 * (its page is gone, the panel was closed), but only while the composer still
 * holds exactly that prompt: what the user typed or edited always stays (§1.3).
 */
function dropStaleInjectedDraft(nodeId: string, readNode: (id: string) => ChatNodeState | undefined, setComposerDraft: SetComposerDraft): void {
  const injected = takeInjectedAssistantDraft(nodeId);
  if (injected && isUntouchedInjectedDraft(injected, readNode(nodeId)?.composerDraft)) setComposerDraft(nodeId, null);
}

const inComposer = (target: EventTarget | null) => target instanceof Element && !!target.closest('.terminal-composer');

/** Per machine: the one-time note for someone who used ⌘J before v2 was dismissed (small UI state). */
const UPGRADE_NOTE_KEY = 'michi:companion:v2-upgrade-note';

function readUpgradeNoteDismissed(): boolean {
  try { return window.localStorage.getItem(UPGRADE_NOTE_KEY) === '1'; } catch { return true; }
}

/**
 * Shown above the composer, until dismissed, only to someone who talked to ⌘J
 * before v2 (the backend says so: `hadMessagesBeforeMerge`, D7), never to a
 * new user after their first message: ⌘J opens the agent now, the same
 * conversation (DESIGN-v2 §1.5).
 */
function UpgradeNote({ name, onDismiss }: { name: string; onDismiss(): void }) {
  return (
    <p className="companion-upgrade-note" role="note">
      <span>
        ⌘J now opens {name}: the same conversation, now with check-ins on your work. Scheduled-job chats are under History.
        Replies use Settings › {name} › Reasoning (High or lower by default).
      </span>
      <button type="button" className="companion-icon-btn" aria-label="Dismiss" onClick={onDismiss}>×</button>
    </p>
  );
}

/**
 * Chat (DESIGN-v2 §1.1–§1.3): the one visible conversation V in a normal
 * composer (TPane), with the proposals waiting on the user above it. It needs
 * only `/assistant` (V's node), never the Companion snapshot, which adds the
 * cards, the welcome and the receipts' titles when it is there. Each message
 * carries what is on screen when it is sent; posted check-ins render as
 * posts (speaker, receipt, allow-listed links, chips that only fill the
 * composer); nothing in V is hidden.
 */
export function CompanionChatTab({ snapshot, page }: { snapshot: CompanionSnapshot | null; page?: PageId }) {
  const assistant = useCompanionAssistant();
  const info = assistant.info;
  const nodeId = info?.nodeId ?? null;
  const panel = useCompanionPanel();
  const name = useCompanionName();
  const { state: nodeState, retry } = useAssistantNode(info);
  const ready = !!nodeId && nodeState === 'ready';
  const readNode = useChatNodeReader();
  const { setComposerDraft, dispatch } = useChatActions();
  const spaces = useCompanionSpacesScreen();
  const composer = useAssistantComposer(nodeId);

  useEffect(() => { void loadCompanionAssistant(); }, []);

  // What is on screen follows the user outside Pages ("On screen: …"); Pages sends its own fields.
  const livePage = useLivePage(page, nodeId);
  useEffect(() => {
    if (nodeId) setAssistantPage(nodeId, spaces ? { kind: 'other' } : livePage);
  }, [nodeId, livePage, spaces]);

  // Opens' requests land once the conversation is in (§1.3); a failed load drops them.
  useEffect(() => {
    if (!ready || !nodeId) return;
    for (const request of takeCompanionRequests()) {
      if (request.attachments?.length) addAssistantAttachments(nodeId, request.attachments);
      const send = request.send?.trim();
      if (send) requestAssistantSend(nodeId, send);
      const draft = request.draft?.trim();
      if (draft) {
        setComposerDraft(nodeId, { value: draft, mentions: [] });
        noteAssistantDraftInjected(nodeId, draft);
        // Check-in text (a brief card's action): the message it drafts replies to that post (D9, §2.8 T4).
        if (request.replyToPost) noteCompanionPostReply(nodeId, request.replyToPost);
      }
    }
  }, [ready, nodeId, panel.requestSeq, setComposerDraft]);

  // A message the panel was asked to show (Activity's View, a source jump into V): scrolled to and
  // briefly highlighted once it is in (TPane's michi:scroll-to-message waits for it to render).
  const focusMessage = panel.focusMessage;
  useEffect(() => {
    if (!ready || !nodeId || !focusMessage) return;
    takeCompanionFocusMessage(focusMessage.seq);
    window.dispatchEvent(new CustomEvent('michi:scroll-to-message', { detail: { nodeId, messageId: focusMessage.id, flash: true } }));
  }, [ready, nodeId, focusMessage]);
  useEffect(() => {
    if (nodeState === 'failed' || assistant.status === 'error') dropCompanionRequests();
  }, [nodeState, assistant.status]);

  // An injected draft goes with its moment: the page it was for is gone, or the panel closed.
  const pageKey = assistantPageKey(composer.page);
  useEffect(() => {
    if (nodeId && injectedAssistantDraftIsStale(nodeId)) dropStaleInjectedDraft(nodeId, readNode, setComposerDraft);
  }, [nodeId, pageKey, readNode, setComposerDraft]);
  useEffect(() => {
    if (!nodeId) return undefined;
    return subscribeCompanionPanel(() => {
      if (!getCompanionPanelState().open) dropStaleInjectedDraft(nodeId, readNode, setComposerDraft);
    });
  }, [nodeId, readNode, setComposerDraft]);

  // Each message's context (area, target, refs) is read when it is sent by state/companion/companionTurnSource.ts,
  // registered at module level, so a send that goes out after this tab unmounted still carries it (§1.3).

  // The welcome (§3.8): asked for while the Chat shows and the snapshot says it is wanted.
  const wantsWelcome = ready && !!snapshot?.welcome?.wanted && snapshot.settings.enabled && !snapshot.settings.paused;
  useEffect(() => (wantsWelcome && nodeId ? wantCompanionWelcome(nodeId) : undefined), [wantsWelcome, nodeId]);

  // Leaving the tab ends any composing the backend was told about.
  useEffect(() => () => noteCompanionComposing(false), []);

  const items = snapshot?.items;
  const itemUrls = useMemo(() => companionItemUrls(items ?? []), [items]);
  const postLinks = useMemo(() => companionLinkRenderer(itemUrls, name), [itemUrls, name]);
  const projects = useOptionalChatProjects()?.projects;
  const agentStatus = useOptionalChatProjects()?.agentStatus;
  const runtimeName = useCallback(
    (runtimeId: string) => agentStatus?.availableRuntimes?.find((runtime) => runtime.id === runtimeId)?.label || runtimeId,
    [agentStatus?.availableRuntimes],
  );
  // Tool calls in plain words. Items, goals and pages are read when a line is made, so a snapshot read
  // does not re-render every message.
  const toolNames = useMemo<CompanionToolLineNames>(() => ({
    workspace: (id) => projects?.find((project) => project.id === id && !project.system)?.name ?? null,
    page: (id) => (id === getSpacesHomeIds().home?.id ? 'Home'
      : knownSpacesPages((projects ?? []).map((p) => ({ id: p.id, name: p.name }))).find((p) => p.id === id)?.title ?? null),
    item: (id) => getCompanionState().snapshot?.items.find((item) => item.id === id)?.title ?? null,
    goal: (id) => getCompanionState().snapshot?.goals.find((goal) => goal.id === id)?.text ?? null,
  }), [projects]);
  const currentPageId = spaces ? viewPageId(spaces.view) : null;
  const switches = info?.runtimeSwitches;
  const decorations = useMemo<MetaChatDecorations>(() => {
    const cardsContext: MetaChatCardsContext = {
      backendConnectionId: LOCAL_BACKEND_CONNECTION_ID,
      workspaceId: info?.workspaceId ?? '',
      currentPageId,
      runtimeLabel: runtimeName,
    };
    const byMessage = new Map((switches ?? []).map((change) => [change.afterMessageId, change]));
    return {
      assistantLabel: <span className="companion-speaker">{name}</span>,
      assistantLabelFor: (message) => <span className="companion-speaker" data-post={companionPostOf(message) ? '' : undefined}>{companionSpeaker(name, message)}</span>,
      // A post's links: the agent's allow-list; a reply's: the assistant's. Nothing loads by itself in either.
      linkRendererFor: (message) => (companionPostOf(message) ? postLinks : COMPANION_REPLY_LINKS),
      toolLine: (tool) => companionToolLine(tool, toolNames) ?? metaAgentToolLine(tool, toolNames),
      workLine: (tools) => companionWorkLine(tools, toolNames),
      toolCards: (tools) => <MetaChatCards tools={tools} context={cardsContext} />,
      afterMessage: (message) => {
        const post = companionPostOf(message);
        const change = byMessage.get(message.id);
        return (
          <>
            {post && message.companionPost && <CompanionReceipt post={message.companionPost} name={name} />}
            <CompanionTurnNotes message={message} name={name} />
            {change && (
              <div className="meta-chat-runtime-switch" role="separator" aria-label={`From here on: ${runtimeName(change.runtimeId)}`}>
                <span>From here on: {runtimeName(change.runtimeId)}</span>
              </div>
            )}
          </>
        );
      },
    };
  }, [currentPageId, info?.workspaceId, name, postLinks, runtimeName, switches, toolNames]);
  const source = useMemo(() => companionAssistantSource(info), [info]);

  // The conversation so far, for the starter suggestions: they show only on an empty conversation in Pages.
  const hasConversation = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => !!nodeId && (nodes[nodeId]?.messages.length ?? 0) > 0, [nodeId]));
  const busy = useStructuralSelector(useCallback(
    (nodes: Record<string, ChatNodeState>) => !!nodeId && nodes[nodeId]?.status === 'streaming', [nodeId]));
  // Starter suggestions are about the page on screen (F1a-review #16): none on a remote connection,
  // which the agent cannot read, and a layout-rule one only while that page lacks the rule.
  const view = spaces?.view ?? null;
  const remoteView = !!view && (view.kind === 'page' ? !spacesSupportsConnection(view.backendConnectionId)
    : view.kind === 'workspace' && !spacesSupportsConnection(backendConnectionIdForWorkspace(view.workspaceId)));
  const offered = view && !hasConversation && !composer.injected && !remoteView ? SPACES_SUGGESTIONS[view.kind] : NO_SUGGESTIONS;
  const asksForRule = offered.some((suggestion) => suggestion.rule);
  const { rules: layoutRules } = useLayoutRules(asksForRule ? currentPageId : null, 'local');
  const suggestions = useMemo(() => (offered.length ? visibleSuggestions(offered, [], layoutRules) : NO_SUGGESTIONS), [offered, layoutRules]);
  const fillSuggestion = useCallback((text: string) => {
    if (nodeId) setComposerDraft(nodeId, { value: text, mentions: [] });
  }, [nodeId, setComposerDraft]);

  // The one-time note for someone who used ⌘J before v2 (the backend decides, D7), until dismissed.
  const [noteDismissed, setNoteDismissed] = useState(readUpgradeNoteDismissed);
  const showUpgradeNote = info?.hadMessagesBeforeMerge === true && !noteDismissed;
  const dismissNote = useCallback(() => {
    setNoteDismissed(true);
    try { window.localStorage.setItem(UPGRADE_NOTE_KEY, '1'); } catch { /* it shows again next time */ }
  }, []);

  // What the next message tells about the screen outside Pages, as a chip the user can remove (§1.3).
  const onScreen = assistantPageCaption(pendingAssistantPage(composer));

  const target = panel.target;
  const preBlocks = useCallback((draftHasText: boolean) => (
    <>
      {showUpgradeNote && <UpgradeNote name={name} onDismiss={dismissNote} />}
      {onScreen && nodeId && (
        <span className="meta-chat-panel__target" data-on-screen="">
          On screen: {onScreen}
          <button type="button" aria-label="Don’t send what’s on screen" onClick={() => dismissAssistantPage(nodeId)}><X size={11} aria-hidden /></button>
        </span>
      )}
      {target && (
        <span className="meta-chat-panel__target">
          Targeting: {target.title || 'this block'}
          <button type="button" aria-label="Clear target" onClick={() => setCompanionTarget(null)}><X size={11} aria-hidden /></button>
        </span>
      )}
      {!draftHasText && suggestions.length > 0 && (
        <MetaChatSuggestions suggestions={suggestions} busy={busy} onSuggestion={(suggestion) => fillSuggestion(suggestion.label)} />
      )}
    </>
  ), [showUpgradeNote, name, dismissNote, onScreen, nodeId, target, suggestions, busy, fillSuggestion]);

  // The first run's closing question (F1a-review #5): an option that continues in another conversation
  // opens it with its draft, unsent, instead of being sent here as a message.
  const openOptions = useNarrationOpenOptions(info, busy);
  const openOptionsRef = useRef(openOptions);
  openOptionsRef.current = openOptions;
  const openFromFollowUp = useCallback((event: React.SyntheticEvent) => {
    const row = event.target instanceof Element ? event.target.closest('.t-followup-row') : null;
    const label = row?.querySelector('.t-followup-text')?.textContent?.trim();
    const option = label ? openOptionsRef.current.get(label) : undefined;
    if (!option) return false;
    event.preventDefault();
    event.stopPropagation();
    void openConversationFromSpaces({ backendConnectionId: LOCAL_BACKEND_CONNECTION_ID, workspaceId: option.workspaceId, nodeId: option.nodeId, focus: true })
      .then((opened) => { if (opened) dispatch({ type: 'append-composer-line', nodeId: option.nodeId, text: option.draft }); });
    return true;
  }, [dispatch]);

  const now = Date.now();
  const cards = snapshot ? snapshot.cards.filter((card) => card.status === 'pending' && card.expiresAt > now) : [];
  const needsYou = snapshot ? itemsInBucket(snapshot.items, 'needs_you').length : 0;

  let body: React.ReactNode;
  if (assistant.status === 'error') {
    body = (
      <p className="companion-status-msg" role="status">
        Couldn’t reach {name}.{' '}
        <button type="button" className="companion-link-btn" onClick={() => { void loadCompanionAssistant(); }}>Retry</button>
      </p>
    );
  } else if (ready && nodeId) {
    body = (
      <div
        className="companion-conversation"
        onFocusCapture={(event) => { if (inComposer(event.target)) noteCompanionComposing(true); }}
        onBlurCapture={(event) => { if (inComposer(event.target) && !inComposer(event.relatedTarget)) noteCompanionComposing(false); }}
        onKeyDownCapture={(event) => {
          if (inComposer(event.target)) noteCompanionComposing(true);
          // A follow-up's B (branch) on an option that opens a conversation opens it too.
          else if (event.key === 'b' || event.key === 'B') openFromFollowUp(event);
        }}
        onClickCapture={openFromFollowUp}
      >
        <MetaChatDecorationsContext.Provider value={decorations}>
          <AssistantLinkScope>
            <MarkdownLinkRendererContext.Provider value={COMPANION_REPLY_LINKS}>
              <TPane key={nodeId} nodeId={nodeId} embedded spacesAssistant assistantSource={source}
                composerFocusToken={panel.composerFocusSeq} composerPreBlocks={preBlocks} />
            </MarkdownLinkRendererContext.Provider>
          </AssistantLinkScope>
        </MetaChatDecorationsContext.Provider>
      </div>
    );
  } else if (nodeState === 'failed') {
    body = (
      <p className="companion-status-msg" role="status">
        Couldn’t load the conversation.{' '}
        <button type="button" className="companion-link-btn" onClick={retry}>Retry</button>
      </p>
    );
  } else {
    body = <p className="companion-status-msg" aria-busy="true">Loading the conversation…</p>;
  }

  return (
    <div className="companion-chat" role="tabpanel" aria-label="Chat">
      {snapshot && (cards.length > 0 || needsYou > 0) && (
        <div className="companion-strip">
          {needsYou > 0 && (
            <button type="button" className="companion-needs-pill" onClick={() => setCompanionPanelTab('today')}>
              Needs you ({needsYou})
            </button>
          )}
          <CardStrip cards={cards} snapshot={snapshot} />
        </div>
      )}
      {body}
    </div>
  );
}
