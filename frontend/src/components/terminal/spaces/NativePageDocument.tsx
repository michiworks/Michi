import { NativeHomeSection } from './home/NativeHomeSection';
import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, Copy, EyeOff, Quote, Sparkles, SquareCheck } from 'lucide-react';
import { isCheckinBlockSource, type BlockSource, type PageBlock, type PageDto, type PageEditOp } from 'michi-shared';
import { BlockFrame, type ApplyResult, type OrphanDraft, type PageChrome } from '../content/page/BlockFrame';
import { MichiBlock } from '../content/page/MichiBlock';
import { PageChangedNote, TextBlockEditor } from '../content/page/BlockEditor';
import type { MichiMenuEntry } from '../content/page/MichiMenu';
import type { MichiPageBlock } from 'michi-shared';
import type { MichiPageEditOp } from '../content/page/editorTypes';
import type { MichiBlockCtx } from '../content/page/blockTypes';
import { toggledChecklist } from '../content/page/pageEdits';
import { PAGE_LIMITS, pageBlockText, pageBlockTitle, pageSegmentSources } from 'michi-shared';
import { toMichiBlock, toNativePageOps } from './nativeBlockAdapter';
import { useBlockDecisions } from './useBlockDecisions';
import { usePageBlockDrag } from './usePageBlockDrag';
import './nativeBlocks.css';
import { MichiMantine } from '../content/page/mantine/MichiMantine';
import { PageBlocksContext } from '../content/page/vendor-blocks/src/desk/blocks/catalog/text/outline';
import type { PageBlockWithSources } from '../content/page/vendor-blocks/shared/desk-blocks';
import { getCompanionPanelState, openCompanionPanel, setCompanionTarget, useCompanionPanel, type CompanionPanelTarget } from '../../../state/companion/companionPanel';
import { useCompanionAssistant } from '../../../state/companion/companionStore';
import { useCompanionName } from '../../../state/companion/companionName';
import { pageBlockTarget } from './metaChat/blockTarget';
import { backendConnectionIdForWorkspace } from '../../../config/backendConnections';
import { NativeMarkdownSegments, nativeSourceRows } from './NativeMarkdownSegments';
import { PageViewEntry, PageViewHost } from '../content/page/PageViewContext';
import { copyText } from '../../../lib/clipboard';

export interface NativePageDocumentProps {
  page: PageDto;
  /** Home may place segments around native sections; edits still use the full page. */
  visibleBlocks?: readonly PageBlock[];
  sourceLabel?(source: BlockSource): string | undefined;
  onEdit(ops: PageEditOp[], revision: number): Promise<ApplyResult>;
  onOpenPage(pageId: string): void;
  onOpenSource?(source: BlockSource): void | boolean | Promise<void | boolean>;
  onAsk?(block: PageBlock, question: string): void;
  /**
   * Set: Ask ("Ask <name>") hands the block to the agent's panel instead of
   * asking for a question, and each checklist item offers its own Ask (`item`
   * is then set). See useCompanionTargeting.
   */
  onAskAssistant?(block: PageBlock, item?: { index: number; text: string }): void;
  /** A plain click on a block toggles its selection. */
  selectOnClick?: boolean;
  renderDatabaseRef(block: Extract<PageBlock, { type: 'database-ref' }>, compact?: boolean, readOnly?: boolean): React.ReactNode;
  renderDecorations?(block: PageBlock): React.ReactNode;
  onOrphanDraft?(draft: OrphanDraft): void;
  compact?: boolean;
  readOnly?: boolean;
  onSelectBlock?(block: PageBlock, mode: 'toggle' | 'extend'): void;
  selectedBlockIds?: readonly string[];
  onSelectionChange?(selection: { blockId: string; title: string; content: string } | null): void;
  renderComponent?(block: PageBlock): React.ReactNode;
  /** Thread cards: the conversations a block names, with their live state. */
  renderThreads?(block: Extract<PageBlock, { type: 'threads' }>): React.ReactNode;
  /** Task boards: the page's workspace's task database in the view a `task-view` block names, at the top or inside a container. */
  renderTaskView?(block: { viewId?: string; title?: string }, compact?: boolean, readOnly?: boolean): React.ReactNode;
  addEntries?(afterId: string, anchor: HTMLElement | null): MichiMenuEntry[];
  /** What the "+" at the foot of a container's section offers (a task board); `insert` puts a block last in that section. */
  slotAddEntries?(insert: (block: MichiPageBlock) => void): MichiMenuEntry[];
  /** Set: each next step offers "Start a conversation" with its text, in this page's workspace. */
  onStartConversation?(text: string, workspaceId: string): void;
  /** Opens a conversation a block names (a conflict's version); without it the name is plain text. */
  onOpenConversation?(nodeId: string): void;
}

/** What a native block's Copy puts on the clipboard: the block as the block catalog writes it. */
function nativeText(block: PageBlock | undefined): string {
  return block ? pageBlockText(block) : '';
}

/** What an item's "Targeting" chip says: its text, cut at 60 characters. */
function itemTitle(item: { index: number; text: string }): string {
  const chars = Array.from(item.text.replace(/\s+/g, ' ').trim());
  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : chars.join('') || `Item ${item.index + 1}`;
}

/**
 * A block (or one of its checklist items) as the panel's target: in any area
 * the message about it goes with the Spaces fields (pageId, blockId,
 * blockItem), so the block is found again (DESIGN-v2 §1.3, "target 不分区域").
 */
export function companionBlockTarget(
  page: Pick<PageDto, 'id' | 'workspaceId'> & { backendConnectionId?: string }, blockId: string, title: string, item?: { index: number; text: string },
): CompanionPanelTarget {
  return {
    pageId: page.id,
    blockId,
    workspaceId: page.workspaceId,
    backendConnectionId: page.backendConnectionId ?? backendConnectionIdForWorkspace(page.workspaceId),
    title: item ? itemTitle(item) : title,
    ...(item ? { itemIndex: item.index, itemText: item.text } : {}),
  };
}

const NO_BLOCK_IDS: readonly string[] = [];

/** What the panel's "Targeting" chip calls a block of a page (a Space page, or one in a page pane): as a home names it (pageBlockTarget). */
export function spaceBlockTitle(block: PageBlock): string {
  return pageBlockTarget(block).title;
}

/** The props a page passes NativePageDocument so its blocks are the panel's targets. */
export interface CompanionTargeting {
  onAskAssistant?: NativePageDocumentProps['onAskAssistant'];
  onSelectionChange?: (selection: { blockId: string } | null) => void;
  selectedBlockIds: readonly string[];
  selectOnClick: boolean;
}

const NO_TARGETING: CompanionTargeting = { selectedBlockIds: NO_BLOCK_IDS, selectOnClick: false };

/**
 * A page's blocks as the panel's targets (DESIGN-v2 §1.2, §1.3). "Ask <name>"
 * on a block or a checklist item opens the panel about it, in any area. While
 * the panel is open a click on a block makes it the target ("Targeting: …"),
 * outlined on the page, and a second click clears it; a block's own Select
 * does so with the panel closed too, for the next ⌘J. Leaving the page clears
 * a target on it. Nothing on a read-only page or where there is no assistant.
 * `backendConnectionId`: the backend the page is on, when the host knows it
 * (a page pane); otherwise the page's workspace says.
 */
export function useCompanionTargeting(page: PageDto | null, titleOf: (block: PageBlock) => string, readOnly: boolean, backendConnectionId?: string): CompanionTargeting {
  const panel = useCompanionPanel();
  const { status } = useCompanionAssistant();
  const pageId = page?.id ?? null;
  const pageRef = useRef(page);
  pageRef.current = page;
  const titleRef = useRef(titleOf);
  titleRef.current = titleOf;
  const connectionRef = useRef(backendConnectionId);
  connectionRef.current = backendConnectionId;
  const targetFor = useCallback((block: PageBlock, item?: { index: number; text: string }) => {
    const current = pageRef.current;
    const connection = connectionRef.current;
    return current ? companionBlockTarget(connection ? { id: current.id, workspaceId: current.workspaceId, backendConnectionId: connection } : current, block.id, titleRef.current(block), item) : null;
  }, []);
  const ask = useCallback((block: PageBlock, item?: { index: number; text: string }) => {
    const target = targetFor(block, item);
    if (target) openCompanionPanel({ target, focusComposer: true });
  }, [targetFor]);
  const select = useCallback((selection: { blockId: string } | null) => {
    const block = selection ? pageRef.current?.blocks.find((candidate) => candidate.id === selection.blockId) : undefined;
    const target = block ? targetFor(block) : null;
    if (target) setCompanionTarget(target);
    else if (getCompanionPanelState().target?.pageId === pageRef.current?.id) setCompanionTarget(null);
  }, [targetFor]);
  useEffect(() => () => {
    if (pageId && getCompanionPanelState().target?.pageId === pageId) setCompanionTarget(null);
  }, [pageId]);
  const targetBlockId = pageId && panel.target?.pageId === pageId ? panel.target.blockId ?? null : null;
  const available = !!pageId && !readOnly && status !== 'unsupported';
  const open = panel.open;
  // A block's own Select (its toolbar, its menu) targets it whether or not the panel shows;
  // a plain click on the page only while the panel is open.
  return useMemo<CompanionTargeting>(() => (available ? {
    onAskAssistant: ask,
    onSelectionChange: select,
    selectedBlockIds: targetBlockId ? [targetBlockId] : NO_BLOCK_IDS,
    selectOnClick: open,
  } : NO_TARGETING), [available, ask, open, select, targetBlockId]);
}

/**
 * What of a block loads from the internet once pictures are allowed
 * (`loadImages`), by type: the `loads` fields of the backend's inventory
 * (services/pages/remoteMedia.ts BLOCK_REMOTE_RULES) that the page's
 * renderers draw. Not here: an embed, whose page loads only when the user
 * clicks "Load page", and a link card, which Michi draws without its
 * `image` (content/page/blocks/text.tsx LinkBlock).
 */
const PICTURES: Readonly<Record<string, (block: Record<string, unknown>) => boolean>> = {
  image: () => true,
  gallery: () => true,
  'before-after': () => true,
  carousel: () => true,
  person: (block) => typeof block.avatar === 'string' && block.avatar.trim() !== '',
};
/** Types that load without asking whatever `loadImages` says: the players, and a library component (anything its props name). */
const UNGATED = new Set(['video', 'audio', 'component']);
/** Markdown pictures and raw HTML media, in any text a block renders. */
const TEXT_MEDIA = /!\[|<\s*(?:img|picture|source|video|audio|iframe|embed|object)\b/i;

/** `pictures`: only what `loadImages` holds back; `players`: something it does not, so the block waits whole. */
type RemoteMedia = 'none' | 'pictures' | 'players';

/** What remote media a block (or a block inside it) would show. */
function remoteMediaIn(value: unknown, depth = 0): RemoteMedia {
  // Too deep to read through: hold all of it.
  if (depth > 12) return 'players';
  if (typeof value === 'string') return TEXT_MEDIA.test(value) ? 'pictures' : 'none';
  if (!value || typeof value !== 'object') return 'none';
  const record = value as Record<string, unknown>;
  const type = !Array.isArray(value) && typeof record.type === 'string' ? record.type : null;
  if (type && UNGATED.has(type)) return 'players';
  let found: RemoteMedia = type && PICTURES[type]?.(record) ? 'pictures' : 'none';
  for (const [key, entry] of Object.entries(record)) {
    if (key === 'sources' || key === 'segmentSources') continue;
    const inner = remoteMediaIn(entry, depth + 1);
    if (inner === 'players') return 'players';
    if (inner === 'pictures') found = 'pictures';
  }
  return found;
}

/** A check-in wrote some of this block: one of its sources, or of its segments', is a check-in's. */
function writtenByCheckin(block: PageBlock): boolean {
  return [...pageSegmentSources(block), ...(block.sources ?? [])].some(isCheckinBlockSource);
}

/** "Load images" on a block a check-in wrote; a player inside it waits behind the same button. */
function HeldMedia({ media, onLoad, children }: { media: Exclude<RemoteMedia, 'none'>; onLoad(): void; children: React.ReactNode }) {
  const name = useCompanionName();
  return <div className="native-page-held" data-checkin-media="held">
    <p className="michi-doc-muted" role="note" style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 6px', fontSize: 'var(--fs-sm)' }}>
      <span>{`Part of this came from a ${name} check-in, so its images and media aren’t loaded.`}</span>
      <button type="button" className="michi-doc-link-btn" onClick={onLoad}>Load images</button>
    </p>
    {media === 'players' ? <p className="michi-doc-unknown" role="status">Media not loaded.</p> : children}
  </div>;
}

/**
 * Narrower than this, a page's databases and task boards take their narrow
 * form, as in a page pane beside a chat: three board columns of 230px
 * (content/db/db.css .michi-db-board) no longer fit, as when the panel is
 * docked beside the page or the window is narrow.
 */
const NARROW_PAGE_PX = 720;

/** Whether the element is laid out narrower than NARROW_PAGE_PX; before it is measured (or where nothing is laid out), it is not. */
function useNarrowLayout(ref: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const { width } = element.getBoundingClientRect();
      setNarrow(width > 0 && width < NARROW_PAGE_PX);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return narrow;
}

/** Native Page renderer backed by the same editors/chrome as the Michi page. */
function NativePageDocument(props: NativePageDocumentProps) {
  const identity = JSON.stringify([backendConnectionIdForWorkspace(props.page.workspaceId), props.page.workspaceId, props.page.id]);
  return <PageViewHost key={identity} page={props.page} renderBlocks={ids => <>
    {ids.some(id => !props.page.blocks.some(block => block.id === id)) && <p role="status">Some content in this view is no longer available.</p>}
    <NativePageDocumentContent {...props}
      visibleBlocks={ids.flatMap(id => { const block = props.page.blocks.find(block => block.id === id); return block ? [block] : []; })} detailView />
  </>}>
    <NativePageDocumentContent {...props} />
  </PageViewHost>;
}

function NativePageDocumentContent({
  page,
  visibleBlocks = page.blocks,
  sourceLabel,
  onEdit,
  onOpenPage,
  onOpenSource,
  onAsk,
  onAskAssistant,
  selectOnClick = false,
  renderDatabaseRef,
  renderDecorations,
  onOrphanDraft,
  compact = false,
  readOnly = false,
  onSelectBlock,
  selectedBlockIds,
  onSelectionChange,
  renderComponent,
  renderThreads,
  renderTaskView,
  addEntries,
  slotAddEntries,
  onStartConversation,
  onOpenConversation,
  detailView = false,
}: NativePageDocumentProps & { detailView?: boolean }) {
  // A block's own choices and prompts go to the agent's panel, in any area (DESIGN-v2 §1.3).
  const assistantAvailable = useCompanionAssistant().status !== 'unsupported';
  // Blocks a check-in wrote whose media the user chose to load (DESIGN-v2 §2.6.2).
  const [loadedMedia, setLoadedMedia] = useState<ReadonlySet<string>>(() => new Set());
  const loadMedia = useCallback((blockId: string) => setLoadedMedia((current) => new Set([...current, blockId])), []);
  const companionName = useCompanionName();
  const instanceId = useId();
  const documentRef = useRef<HTMLDivElement>(null);
  // Databases and task boards take their narrow form where the page is narrow (the panel docked beside it).
  const narrowLayout = useNarrowLayout(documentRef);
  const tablesCompact = compact || narrowLayout;
  const drag = usePageBlockDrag(page, documentRef, onEdit, readOnly || detailView);
  const [actionError, setActionError] = useState<string | null>(null);
  const actionPending = useRef(false);
  const [actionBusy, setActionBusy] = useState(false);
  const perform = useCallback(async (ops: PageEditOp[]) => {
    if (readOnly || actionPending.current) return;
    actionPending.current = true;
    setActionBusy(true);
    setActionError(null);
    try {
      const result = await onEdit(ops, page.revision);
      if (result !== 'ok') setActionError(result === 'stale' ? 'The page changed. Try again.' : 'Could not save this change. Try again.');
    } catch { setActionError('Could not save this change. Try again.'); }
    finally { actionPending.current = false; setActionBusy(false); }
  }, [onEdit, page.revision, readOnly]);
  const copy = useCallback((text: string, what: string) => {
    void copyText(text).then((ok) => { if (!ok) setActionError(`Couldn’t copy ${what}. Select it and copy it instead.`); });
  }, []);
  // A tick, pick or kept version shows at once and saves in order; the page catches up with the block it makes.
  const { display: decided, decide: updateBlock, note: decisionNote } = useBlockDecisions(page, onEdit, readOnly);
  const michiBlocks = useMemo(() => visibleBlocks.map((block) => decided(block.id) ?? toMichiBlock(block)), [visibleBlocks, decided]);
  const [internalSelection, setInternalSelection] = useState<string[]>([]);
  const activeSelection = selectedBlockIds ?? internalSelection;
  const nativeById = useMemo(() => new Map(page.blocks.map((block) => [block.id, block])), [page.blocks]);
  const toggleItem = useCallback((display: MichiPageBlock, index: number) => {
    const next = toggledChecklist(display, index);
    if (next) updateBlock(display, next);
  }, [updateBlock]);

  const apply = useCallback(async (ops: MichiPageEditOp[], _label: string, observedRevision?: number): Promise<ApplyResult> => {
    if (readOnly) return 'failed';
    setActionError(null);
    const insertCount = ops.filter((op) => op.op === 'insert').length;
    if (page.blocks.length + insertCount > PAGE_LIMITS.blocks) {
      setActionError(`A page may contain at most ${PAGE_LIMITS.blocks} blocks`);
      return 'failed';
    }
    const nativeOps = toNativePageOps(ops, page);
    let result: ApplyResult = 'failed';
    try {
      if (nativeOps?.length) result = await onEdit(nativeOps, observedRevision ?? page.revision);
    } catch { /* reported below */ }
    if (result === 'failed') setActionError('Could not save this change. Try again.');
    return result;
  }, [onEdit, page, readOnly]);

  const select = useCallback((id: string, mode: 'toggle' | 'extend') => {
      const block = nativeById.get(id);
      if (!block) return;
      onSelectBlock?.(block, mode);
      const next = mode === 'toggle'
        ? (activeSelection.includes(id) ? activeSelection.filter((value) => value !== id) : [...activeSelection, id])
        : [...activeSelection, id];
      if (selectedBlockIds === undefined) setInternalSelection(next);
      const selected = next.length ? nativeById.get(next[next.length - 1]) : undefined;
      onSelectionChange?.(selected ? { blockId: selected.id, title: selectionTitle(selected), content: pageBlockText(selected) } : null);
    }, [activeSelection, nativeById, onSelectBlock, onSelectionChange, selectedBlockIds]);

  const chrome = useMemo<PageChrome>(() => ({
    projectId: page.workspaceId,
    generatedAt: page.revision,
    capabilities: { ask: Boolean(onAsk || onAskAssistant), branch: false, sources: Boolean(onOpenSource), copyLink: false, select: true, drag: !compact && !detailView },
    ask: (michiBlock, question) => {
      const native = michiBlock.id ? nativeById.get(michiBlock.id) : undefined;
      if (native) onAsk?.(native, question);
    },
    askAssistant: onAskAssistant ? (michiBlock) => {
      const native = michiBlock.id ? nativeById.get(michiBlock.id) : undefined;
      if (native) onAskAssistant(native);
    } : undefined,
    branch: () => {},
    apply,
    notice: (text) => setActionError(text),
    copy: (blocks) => { copy(blocks.map((block) => nativeText(typeof block.id === 'string' ? nativeById.get(block.id) : undefined)).filter(Boolean).join('\n\n'), 'the text'); },
    copyText: copy,
    copyLink: () => {},
    sources: (display) => {
      const block = nativeById.get(display.id ?? '');
      return nativeSourceRows(block ? [...pageSegmentSources(block), ...(block.sources ?? [])] : [], sourceLabel, onOpenSource, () => setActionError('Source unavailable'));
    },
    openThread: () => {},
    moving: () => drag.moving || actionBusy,
    move: (id, step) => {
      const ordered = page.blocks.map((block) => block.id);
      const index = ordered.indexOf(id);
      const target = index + step;
      if (index < 0 || target < 0 || target >= ordered.length) return;
      const rest = ordered.filter((candidate) => candidate !== id);
      const after = target === 0 ? null : rest[target - 1];
      const expectRev = nativeById.get(id)?.rev;
      if (expectRev !== undefined) void perform([{ op: 'move', id, after, expectRev }]);
    },
    select,
    marginDown: () => {},
    marginEnter: () => {},
    dragStart: drag.dragStart,
    takeDragged: drag.takeDragged,
    orphan: (draft) => onOrphanDraft?.(draft),
    findBlock: () => null,
    addEntries,
    menuEntries: (display, actions) => {
      const block = nativeById.get(display.id ?? '');
      if (!block) return [];
      const pending = actionBusy || drag.moving;
      return [
        { id: 'select', label: activeSelection.includes(block.id) ? 'Deselect' : 'Select', glyph: <SquareCheck size={15} />, onSelect: () => select(block.id, 'toggle') },
        // Named after the agent where it hands the block to the panel, as the toolbar's Ask (DESIGN-v2 §1.5).
        { id: 'ask', label: onAskAssistant ? `Ask ${companionName}` : 'Ask', glyph: <Sparkles size={15} />, disabled: !onAsk && !onAskAssistant, onSelect: actions.ask },
        { id: 'sources', label: 'Sources', glyph: <Quote size={15} />, disabled: !onOpenSource || !(block.sources?.length || pageSegmentSources(block).length), onSelect: actions.sources },
        { id: 'ignore', label: 'Ignore', glyph: <EyeOff size={15} />, disabled: pending || !!block.edit, title: block.edit ? 'Automatic updates stopped' : 'Keep content and stop automatic updates', onSelect: () => {
          const { id, rev, sources: _sources, edit: _edit, ...content } = block;
          void perform([{ op: 'update', id, block: content, expectRev: rev }]);
        } },
        { id: 'archive', label: 'Archive', glyph: <Archive size={15} />, disabled: pending, title: 'Remove from this page and keep its history', onSelect: () => { void perform([{ op: 'delete', id: block.id, expectRev: block.rev }]); } },
        { divider: true, id: 'clipboard' },
        { id: 'copy', label: 'Copy text', glyph: <Copy size={15} />, onSelect: () => { copy(nativeText(block), 'the text'); } },
      ];
    },
  }), [activeSelection, actionBusy, addEntries, apply, compact, companionName, copy, detailView, drag.dragStart, drag.takeDragged, drag.moving, nativeById, onAsk, onAskAssistant, onOpenSource, onOrphanDraft, onSelectBlock, onSelectionChange, page, perform, select, selectedBlockIds, sourceLabel]);

  const ctx = useMemo<MichiBlockCtx>(() => ({
    depth: 0,
    // A choice that sends opens the panel and sends; a prompt left for review fills the composer.
    ...(!readOnly && assistantAvailable ? { requestAssistant: (display: MichiPageBlock, prompt: string, title: string, send: boolean) => {
      const native = nativeById.get(display.id ?? '');
      if (!native || !prompt.trim()) return false;
      const target = companionBlockTarget(page, native.id, title);
      openCompanionPanel(send ? { target, send: prompt } : { target, draft: prompt });
      return true;
    } } : {}),
    renderNativePageLink: (displayBlock) => {
      const id = typeof displayBlock.pageId === 'string' ? displayBlock.pageId : '';
      const target = page.blocks.find((block) => block.type === 'page-link' && block.pageId === id);
      const label = target?.type === 'page-link' ? (id === page.id ? 'This page' : id) : id;
      return <button type="button" className="michi-doc-link-btn" onClick={() => onOpenPage(id)} disabled={!id}>{label || 'Open page'}</button>;
    },
    renderNativeDatabaseRef: (displayBlock) => {
      const block = page.blocks.find((candidate) => candidate.id === displayBlock.id);
      return block?.type === 'database-ref' ? renderDatabaseRef(block, tablesCompact, readOnly) : <p role="status">This database reference is unavailable.</p>;
    },
    renderNativeThreads: (displayBlock) => {
      const block = page.blocks.find((candidate) => candidate.id === displayBlock.id);
      return block?.type === 'threads' && renderThreads ? renderThreads(block) : <p className="michi-doc-unknown" role="status">These conversations are unavailable here.</p>;
    },
    renderNativeTaskView: (displayBlock) => (renderTaskView ? renderTaskView({
      ...(typeof displayBlock.viewId === 'string' ? { viewId: displayBlock.viewId } : {}),
      ...(typeof displayBlock.title === 'string' ? { title: displayBlock.title } : {}),
    }, tablesCompact, readOnly) : <p className="michi-doc-unknown" role="status">The task board is unavailable here.</p>),
    loadImages: true,
    ...(onOpenConversation ? { openConversation: onOpenConversation } : {}),
    ...(readOnly ? {} : { updateBlock, toggleItem }),
    ...(onAskAssistant && !readOnly ? { askItem: (display: MichiPageBlock, index: number) => {
      const native = nativeById.get(display.id ?? '');
      const item = native?.type === 'checklist' ? native.items[index] : undefined;
      if (native && item) onAskAssistant(native, { index, text: item.text });
    } } : {}),
    ...(readOnly || !slotAddEntries ? {} : { slotAddEntries }),
    ...(onStartConversation && !readOnly ? { startConversation: (text: string) => onStartConversation(text, page.workspaceId) } : {}),
  }), [tablesCompact, onAskAssistant, onOpenConversation, onOpenPage, onStartConversation, page, readOnly, renderDatabaseRef, renderThreads, renderTaskView, slotAddEntries, toggleItem, updateBlock, nativeById, assistantAvailable]);

  const renderBlock = useCallback((displayBlock: MichiPageBlock, blockCtx: MichiBlockCtx) => {
    const native = displayBlock.id ? nativeById.get(displayBlock.id) : undefined;
    if (native?.type === 'home-section') return <><NativeHomeSection section={native.section} pageId={page.id} connectionId={backendConnectionIdForWorkspace(page.workspaceId)} readOnly={readOnly} />{native.interaction && <div className="page-view-block-entry"><PageViewEntry action={native.interaction.action}>{native.interaction.label}</PageViewEntry></div>}</>;
    if (native?.type === 'component' && renderComponent) return <>{renderComponent(native)}{native.interaction && <div className="page-view-block-entry"><PageViewEntry action={native.interaction.action}>{native.interaction.label}</PageViewEntry></div>}</>;
    return <MichiBlock block={displayBlock} ctx={blockCtx} />;
  }, [nativeById, renderComponent, page.id, page.workspaceId, readOnly]);

  const frameFor = useCallback((block: PageBlock, index: number) => {
    const display = michiBlocks[index];
    // The render-side fallback of DESIGN-v2 §2.6.2, failing closed: every block a check-in wrote is drawn
    // with pictures off until the user loads them, whatever it holds, so media remoteMediaIn misses still
    // does not load. That reading decides only whether "Load images" shows, and whether players wait behind it.
    const checkin = writtenByCheckin(block) && !loadedMedia.has(block.id);
    const held = checkin ? remoteMediaIn(block) : 'none';
    return <BlockFrame
      key={block.id}
      id={`page-block-${detailView ? `${instanceId}-` : ''}${block.id}`}
      block={display}
      ctx={{ ...ctx,
        loadImages: !checkin,
        renderNativeMarkdown: (markdown) => <NativeMarkdownSegments blockId={typeof markdown.id === 'string' ? markdown.id : undefined} text={typeof markdown.text === 'string' ? markdown.text : ''} segmentSources={markdown.segmentSources}
          sourceLabel={sourceLabel} onOpenSource={onOpenSource} onError={() => setActionError('Source unavailable')} loadImages={!checkin} />,
        ...(ctx.requestAssistant ? { requestAssistant: (_block, prompt, title, send) => ctx.requestAssistant!(display, prompt, title, send) } : {}) }}
      chrome={readOnly ? null : chrome}
      index={compact || detailView ? undefined : index}
      count={michiBlocks.length}
      selected={activeSelection.includes(block.id)}
      dragging={drag.dragging === block.id}
      renderBlock={held !== 'none' ? (displayBlock, blockCtx) => <HeldMedia media={held} onLoad={() => loadMedia(block.id)}>{renderBlock(displayBlock, blockCtx)}</HeldMedia> : renderBlock}
      renderDecorations={() => <>{renderDecorations?.(block)}{decisionNote?.blockId === block.id && <p className="native-page-decision-note" role="alert">{decisionNote.text}</p>}<div data-page-view-outlet="" /></>}
    />;
  }, [chrome, compact, ctx, michiBlocks, readOnly, renderBlock, renderDecorations, activeSelection, decisionNote, drag.dragging, sourceLabel, onOpenSource, detailView, instanceId, loadedMedia, loadMedia]);

  // The page title and chrome belong to the document shell around this list.
  return (
    <MichiMantine><PageBlocksContext.Provider value={visibleBlocks.filter(block => block.type !== 'view' && (detailView || block.visibility !== 'detail')).map(toMichiBlock) as unknown as PageBlockWithSources[]}>
    <div ref={documentRef} className="michi-doc-blocks" data-native-page="" data-native-page-id={page.id} data-native-workspace-id={page.workspaceId} data-dragging={drag.dragging || undefined} onClick={selectOnClick && !readOnly ? (event) => {
      const id = clickedBlockId(event);
      if (id) chrome.select(id, 'toggle');
    } : undefined} aria-label={`${page.title || 'Untitled page'} content`}>
      {visibleBlocks.map((block, index) => block.type === 'view' || (!detailView && block.visibility === 'detail') ? null : frameFor(block, index))}
      {drag.drop && createPortal(<div className="native-page-drop" aria-hidden="true" style={{ left: drag.drop.left, top: drag.drop.top, width: drag.drop.width }} />, document.body)}
      {(actionError || drag.error) && <p className="native-page-decision-note" role="alert">{actionError || drag.error}</p>}
      {!page.blocks.length && <EmptyPageEditor page={page} onEdit={onEdit} onOrphanDraft={onOrphanDraft} readOnly={readOnly} />}
    </div>
    </PageBlocksContext.Provider></MichiMantine>
  );
}

/** What a selected block is called in the panel's "About" chip: its own title, else its first words, else its kind. */
function selectionTitle(block: PageBlock): string {
  const title = pageBlockTitle(block);
  if (title) return title;
  const first = pageBlockText(block).split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  return first.length > 60 ? `${first.slice(0, 59)}…` : first || block.type;
}

const INTERACTIVE = 'a, button, input, textarea, select, label, summary, [contenteditable="true"], [role="button"], [role="menu"], [role="dialog"], [data-michi-interactive], .michi-doc-block__margin, .michi-doc-toolbar';

/** The top-level block a plain click landed on, unless it hit a control, an editor or ended a text selection. */
function clickedBlockId(event: React.MouseEvent): string | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target as HTMLElement;
  if (target.closest(INTERACTIVE)) return null;
  if (window.getSelection()?.toString()) return null;
  const frame = target.closest<HTMLElement>('.michi-doc-block[data-top]');
  if (!frame || frame.dataset.editing !== undefined || frame.dataset.removing !== undefined) return null;
  return frame.dataset.blockId ?? null;
}

function EmptyPageEditor({ page, onEdit, onOrphanDraft, readOnly = false }: Pick<NativePageDocumentProps, 'page' | 'onEdit' | 'onOrphanDraft' | 'readOnly'>) {
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const draftRef = useRef('');
  const savingRef = useRef(false);
  const openedRevisionRef = useRef(page.revision);
  const [copyFailed, setCopyFailed] = useState(false);
  const changed = conflict || openedRevisionRef.current !== page.revision;
  const save = async (text: string, reapply = false) => {
    if (!text.trim() || savingRef.current || readOnly || (changed && !reapply)) return;
    savingRef.current = true;
    setBusy(true);
    try {
      const result = await onEdit([{ op: 'insert', block: { type: 'markdown', text }, after: null }], page.revision);
      if (result === 'ok') { draftRef.current = ''; setConflict(false); openedRevisionRef.current = page.revision; }
      else if (result === 'stale') setConflict(true);
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };
  useEffect(() => () => {
    const draft = draftRef.current;
    if (draft.trim()) onOrphanDraft?.({ label: 'New text', markdown: draft, text: draft });
  }, [onOrphanDraft]);
  if (readOnly) return <p className="michi-doc-unknown" role="status">This page is read only.</p>;
  return <div className="michi-doc-block__insert" data-empty-page-editor="">
    <TextBlockEditor
      label="New page content"
      initial=""
      placeholder="Write something; Markdown works"
      busy={busy}
      saveLabel="Add text"
      onChange={(text) => { draftRef.current = text; }}
      saveDisabled={readOnly || changed}
      notice={changed ? <PageChangedNote busy={busy} onReapply={() => { void save(draftRef.current, true); }} onCopy={() => { void copyText(draftRef.current).then((ok) => setCopyFailed(!ok)); }} text={copyFailed ? 'The page changed, and your text couldn’t be copied. Select it and copy it instead.' : undefined} /> : null}
      onSave={(text) => { void save(text); }}
      onCancel={() => { draftRef.current = ''; setConflict(false); }}
    />
  </div>;
}

export default NativePageDocument;
