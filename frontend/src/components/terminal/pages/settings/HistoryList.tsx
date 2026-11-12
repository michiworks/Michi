import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock3, Ellipsis, LockKeyhole, Search, X, type LucideIcon } from 'lucide-react';
import { Button } from '../../../ui/controls';
import { fetchTreeMessagePage, fetchWorkspaceStructure } from '../../../../services/api';
import { buildMessagesByNode } from '../../../../state/chatHydration';
import { visibleMessageText } from '../../../../state/assistantBlocks';
import type { ChatMessage, ChatNodeState } from '../../../../state/chatTypes';
import { SearchHighlight } from '../../../ui/SearchHighlight';
import { plural } from 'michi-shared';
import { useSettingsBack, useSettingsPageTitle, useSettingsPhone } from './settingsPhone';
import { isImeComposing } from '../../../../lib/ime';
import './history.css';

/**
 * The parts Settings › Trash, Archived and Skills share: a search and
 * filter bar that turns into a selection bar, titled groups of rows, an
 * empty state, and an item's detail as a level inside the page.
 */

/** The button that opens an entry's row, found by the entry's key. */
export function findRowButton(root: HTMLElement | null, key: string | null): HTMLButtonElement | null {
  if (!root || !key) return null;
  return Array.from(root.querySelectorAll<HTMLButtonElement>('[data-history-open]')).find(button => button.dataset.historyOpen === key) ?? null;
}

export function HistorySearch({ value, onChange, label, placeholder, inputRef }: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return <label className="ui-search settings-history__search">
    <Search size={14} aria-hidden="true" />
    <input ref={inputRef} type="search" aria-label={label} placeholder={placeholder} value={value}
      onChange={event => onChange(event.target.value)}
      onKeyDown={event => {
        // Escape clears a query first; with none, it reaches Settings.
        if (event.key === 'Escape' && value && !isImeComposing(event)) { event.preventDefault(); event.stopPropagation(); onChange(''); }
      }} />
    {value && <button type="button" aria-label="Clear search" onClick={() => { onChange(''); inputRef.current?.focus(); }}><X size={13} aria-hidden="true" /></button>}
  </label>;
}

export function HistoryFilter<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; count: number }>;
  onChange: (value: T) => void;
}) {
  return <div className="settings-history__filter" role="group" aria-label={label}>
    {options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}>
      {option.label} <em>{option.count}</em>
    </button>)}
  </div>;
}

/** What the toolbar shows while rows are selected: how many, and what to do with them. */
export function SelectionBar({ count, total, onToggleAll, onCancel, children }: {
  count: number;
  /** Rows the select-all box covers: those shown. */
  total: number;
  onToggleAll: () => void;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLInputElement>(null);
  const all = total > 0 && count >= total;
  useEffect(() => { if (box.current) box.current.indeterminate = count > 0 && !all; }, [all, count]);
  return <>
    <label className="settings-history__select-all">
      <input ref={box} type="checkbox" className="settings-history__check" checked={all} onChange={onToggleAll} aria-label={all ? 'Clear selection' : 'Select all shown'} />
      <span role="status">{count} selected</span>
    </label>
    <span className="settings-history__spacer" />
    {children}
    <Button variant="ghost" onClick={onCancel}>Cancel</Button>
  </>;
}

/**
 * The bar above the rows. It sticks to the top of the page while the rows
 * scroll, and Escape clears a selection before it closes anything else.
 */
export function HistoryToolbar({ selecting = false, onClearSelection, children }: { selecting?: boolean; onClearSelection?: () => void; children: React.ReactNode }) {
  return <div className="settings-history__toolbar" data-selecting={selecting || undefined}
    onKeyDown={event => { if (event.key === 'Escape' && selecting && onClearSelection) { event.stopPropagation(); onClearSelection(); } }}>
    {children}
  </div>;
}

export function HistoryGroup({ title, badge, count, footer, children }: {
  title: string;
  badge?: React.ReactNode;
  /** Absent when the number would mislead: a source that couldn't say what it holds. */
  count?: number;
  /** Under the rows: notes about the group. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const id = useId();
  return <section className="settings-history__group" aria-labelledby={id}>
    <h3 id={id} className="settings-history__group-title">{badge}{title}{count !== undefined && <> <em aria-label={plural(count, 'item')}>{count}</em></>}</h3>
    {React.Children.toArray(children).length > 0 && <ul className="settings-history__card">{children}</ul>}
    {footer}
  </section>;
}

export interface HistoryRowProps {
  /** The entry's key; rows are found by it to keep focus after a change. */
  id: string;
  icon: LucideIcon;
  title: string;
  query: string;
  meta: ReadonlyArray<React.ReactNode>;
  /** Right of the row at rest: when it happened, or a short status (`status`), which is also part of the row's description. */
  when?: { label: string; dateTime?: string; title?: string; soon?: boolean; status?: boolean };
  onOpen: () => void;
  /** Rows that can be selected and acted on (Trash, Archived). Without them a row only opens. */
  selected?: boolean;
  /** Rows show their checkboxes: something is selected, or the phone's Select is on. */
  selecting?: boolean;
  busy?: boolean;
  menuOpen?: boolean;
  primary?: { label: string; icon: LucideIcon };
  onToggle?: () => void;
  onPrimary?: () => void;
  onMenu?: (anchor: HTMLButtonElement) => void;
}

export function HistoryRow({ id, icon: Icon, title, query, meta, when, onOpen, selected = false, selecting = false, busy = false, menuOpen = false, primary, onToggle, onPrimary, onMenu }: HistoryRowProps) {
  const phone = useSettingsPhone();
  const metaId = useId();
  const statusId = useId();
  const Primary = primary?.icon;
  return <li className="settings-history__row" data-history-key={id} data-selected={selected || undefined}>
    <span className="settings-history__lead">
      <span className="settings-history__kind" aria-hidden="true"><Icon size={15} strokeWidth={1.75} /></span>
      {onToggle && <input type="checkbox" className="settings-history__check" checked={selected} disabled={busy} onChange={onToggle} aria-label={`Select ${title}`} />}
    </span>
    {/* On a phone with Select on, a tap anywhere on the row selects it. */}
    <button type="button" className="settings-history__open" data-history-open={id} aria-label={title} aria-describedby={when?.status ? `${metaId} ${statusId}` : metaId}
      onClick={phone && selecting && onToggle ? onToggle : onOpen} aria-pressed={phone && selecting && onToggle ? selected : undefined}>
      <span className="settings-history__title"><SearchHighlight text={title} query={query} /></span>
      <span className="settings-history__meta" id={metaId}>{meta.map((part, index) => <React.Fragment key={index}>
        {index > 0 && <span className="settings-history__dot" aria-hidden="true">·</span>}{typeof part === 'string' ? <span>{part}</span> : part}
      </React.Fragment>)}</span>
    </button>
    <span className="settings-history__end">
      {when && (when.status
        ? <span id={statusId} className="settings-history__when" title={when.title}>{when.label}</span>
        : <time className="settings-history__when" data-soon={when.soon || undefined} dateTime={when.dateTime} title={when.title}>
          {when.soon && <Clock3 size={12} aria-hidden="true" />}{when.label}
        </time>)}
      {!phone && primary && Primary && <span className="settings-history__actions">
        <Button size="sm" disabled={busy} aria-label={`${primary.label} ${title}`} onClick={onPrimary}><Primary size={13} aria-hidden="true" />{primary.label}</Button>
        {onMenu && <button type="button" className="settings-history__more" aria-label={`More actions for ${title}`} aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy}
          onClick={event => onMenu(event.currentTarget)}><Ellipsis size={15} aria-hidden="true" /></button>}
      </span>}
      {phone && !selecting && <ChevronRight className="settings-history__chevron" size={16} aria-hidden="true" />}
    </span>
  </li>;
}

export function HistoryEmpty({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return <div className="settings-history__empty">
    <Icon size={26} strokeWidth={1.5} aria-hidden="true" />
    <h3>{title}</h3>
    <p>{children}</p>
    {action}
  </div>;
}

export function HistoryLoading({ label }: { label: string }) {
  return <div className="settings-history__loading" role="status" aria-label={label}><span /><span /><span /></div>;
}

/**
 * An item's detail, a level inside the page rather than a second window
 * over Settings. Back (the link, Escape, or the phone's header Back)
 * returns to the list; the actions stay at the bottom of the page.
 */
export function HistoryDetail({ backLabel, onBack, icon: Icon, kind, title, details, actions, note, readOnly = true, pageTitle = false, lead, children }: {
  backLabel: string;
  onBack: () => void;
  icon: LucideIcon;
  kind: string;
  title: string;
  details: ReadonlyArray<{ label: string; value: React.ReactNode; soon?: boolean }>;
  actions?: React.ReactNode;
  note?: string;
  /** Marks the item Read only beside its kind. */
  readOnly?: boolean;
  /** The item's title replaces the page's (Skills) rather than sitting under it (Trash). */
  pageTitle?: boolean;
  /** Above the details: the item's own settings. */
  lead?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const phone = useSettingsPhone();
  const heading = useRef<HTMLHeadingElement>(null);
  useSettingsBack(onBack);
  useSettingsPageTitle(pageTitle);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  return <div className="settings-history__detail"
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onBack(); } }}>
    {!phone && <button type="button" className="settings-history__back" onClick={onBack}><ChevronLeft size={15} aria-hidden="true" />{backLabel}</button>}
    {pageTitle
      ? <h1 ref={heading} tabIndex={-1} className="terminal-settings-heading">{title}</h1>
      : <h2 ref={heading} tabIndex={-1} className="settings-history__detail-title">{title}</h2>}
    <p className="settings-history__detail-kind"><Icon size={14} aria-hidden="true" />{kind}
      {readOnly && <span className="settings-history__lock"><LockKeyhole size={11} aria-hidden="true" />Read only</span>}</p>
    {lead}
    <section className="settings-section" aria-label="Details">
      <div className="settings-section__head"><h3 className="settings-section__title">Details</h3></div>
      <dl className="settings-section__body settings-history__details">
        {details.map(row => <div key={row.label} className="settings-row"><dt>{row.label}</dt><dd data-soon={row.soon || undefined}>{row.value}</dd></div>)}
      </dl>
    </section>
    {children}
    {actions && <div className="settings-history__detail-actions">{actions}{note && <p>{note}</p>}</div>}
  </div>;
}

/** A titled list of what an item contains: its nodes, pages or threads. */
export function HistoryContents({ title, items }: { title: string; items: ReadonlyArray<{ id: string; icon: LucideIcon; label: React.ReactNode; note?: string }> }) {
  return <section className="settings-section">
    <div className="settings-section__head"><h3 className="settings-section__title">{title}</h3><span className="settings-section__aside">{items.length}</span></div>
    <ul className="settings-section__body settings-history__contents">
      {items.map(({ id, icon: Icon, label, note }) => <li key={id} className="settings-row"><Icon size={14} aria-hidden="true" /><span>{label}</span>{note ? <small>{note}</small> : <span />}</li>)}
    </ul>
  </section>;
}

const PREVIEW_MESSAGES = 20;

/**
 * A node's latest messages, without its workspace's other bodies: the
 * workspace structure names the node's thread, then one page of the node.
 */
async function fetchLatestMessages(workspaceId: string, nodeId: string, signal: AbortSignal): Promise<{ messages: ChatMessage[]; total: number }> {
  const gone = () => new Error('This thread is no longer available.');
  const structure = await fetchWorkspaceStructure(workspaceId, signal);
  const rows = (structure as { nodes?: Array<{ id?: unknown; tree_id?: unknown } | null> } | null)?.nodes;
  const treeId = Array.isArray(rows) ? rows.find(row => row?.id === nodeId)?.tree_id : undefined;
  if (typeof treeId !== 'string' || !treeId) throw gone();
  const page = await fetchTreeMessagePage(workspaceId, treeId, undefined, signal, { nodeId, limit: PREVIEW_MESSAGES });
  const bounds = page.pages?.find(item => item.nodeId === nodeId);
  if (page.pages && !bounds) throw gone();
  // A gateway without pages answers with every body of the thread.
  const messages = buildMessagesByNode(page.messages)[nodeId] ?? [];
  return { messages: messages.slice(-PREVIEW_MESSAGES), total: bounds?.total ?? messages.length };
}

/** The latest messages of a node, read from the store or fetched without touching it. */
export function ConversationPreview({ node, messageCount }: { node: ChatNodeState; messageCount: number }) {
  const [remote, setRemote] = useState<{ messages: ChatMessage[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef<{ key: string; controller: AbortController; abortTimer: ReturnType<typeof setTimeout> | null } | null>(null);
  const loaded = node.messagesLoaded === true;
  useEffect(() => {
    if (loaded) return;
    const requestKey = `${node.projectId}:${node.nodeId}:${attempt}`;
    const existing = requestRef.current;
    if (existing?.key === requestKey && !existing.controller.signal.aborted) {
      if (existing.abortTimer !== null) clearTimeout(existing.abortTimer);
      existing.abortTimer = null;
      return () => { existing.abortTimer = setTimeout(() => existing.controller.abort(), 0); };
    }
    const request = { key: requestKey, controller: new AbortController(), abortTimer: null as ReturnType<typeof setTimeout> | null };
    requestRef.current = request;
    setRemote(null);
    setError(null);
    // Read a detached snapshot: a preview never hydrates or writes back to the live store.
    // Delaying cleanup by one task lets React StrictMode's immediate effect replay reuse
    // this request; a real unmount leaves the timer in place and aborts the request.
    void fetchLatestMessages(node.projectId, node.nodeId, request.controller.signal).then(latest => {
      if (request.controller.signal.aborted || requestRef.current !== request) return;
      setRemote(latest);
    }).catch((reason: unknown) => {
      if (!request.controller.signal.aborted && requestRef.current === request) setError(reason instanceof Error ? reason.message : 'Could not load conversation.');
    });
    return () => { request.abortTimer = setTimeout(() => request.controller.abort(), 0); };
  }, [node.projectId, node.nodeId, loaded, attempt]);
  const messages = loaded ? node.messages : remote?.messages ?? null;
  let body: React.ReactNode;
  if (error) body = <div className="settings-history__preview-error" role="alert"><p>{error}</p><Button size="sm" onClick={() => setAttempt(value => value + 1)}>Retry</Button></div>;
  else if (!messages) body = <HistoryLoading label="Loading conversation" />;
  else if (!messages.length) body = <p className="settings-history__preview-empty">No messages in this thread.</p>;
  else body = messages.slice(-PREVIEW_MESSAGES).map(message => <article className="settings-history__message" data-role={message.role} key={message.id}>
    <h4>{message.role === 'user' ? 'You' : 'Assistant'}</h4>
    <p>{visibleMessageText(message) || (message.toolCalls.length ? 'Tool activity' : message.attachments?.length ? 'Attachment' : 'No text content')}</p>
  </article>);
  const total = loaded ? node.messages.length : remote?.total ?? messageCount;
  return <section className="settings-section">
    <div className="settings-section__head"><h3 className="settings-section__title">Conversation</h3>
      <span className="settings-section__aside">{total > PREVIEW_MESSAGES ? `Latest ${PREVIEW_MESSAGES} of ${plural(total, 'message')}` : plural(total, 'message')}</span></div>
    <div className="settings-section__body settings-history__transcript">{body}</div>
  </section>;
}
