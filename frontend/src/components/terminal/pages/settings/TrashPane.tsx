import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Clock3, FileText, Folder, MessageSquare, Search, Trash2, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useChatStore, useChatNodesSnapshot } from '../../../../state/chatStore';
import { LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import { listPageTrash, purgePage, restorePage, type PageTrashEntry } from '../../../../services/api/pages';
import { notifyPageChanged } from '../../../../state/pages/pageEvents';
import { usePrefs } from '../../../../state/prefs';
import type { PageId } from '../../../../state/commands';
import { withoutSystemWorkspaces } from '../../../../state/assistant/systemWorkspace';
import { plural } from 'michi-shared';
import { threadDisplayTitle } from '../../../../state/displayTitle';
import { nodeMessageCount } from '../../../../state/nodeMessageCount';
import { workspaceAccent } from '../../workspaceAccent';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { Button } from '../../../ui/controls';
import { TrashIconButton, TrashMenu } from '../TrashControls';
import {
  buildPageTrashEntries, buildTrashSections, entryDeletedAt, entryKey, entryRemainingDays, entryTitle, groupByBucket, groupsPastRetention,
  isExpiringSoon, relativeDeletion, type TrashEntry,
} from '../trashModel';
import { SettingsRow, SettingsSection } from './SettingsSection';
import { useSettingsPhone } from './settingsPhone';
import { useNow } from '../../../../hooks/useNow';
import {
  ConversationPreview, findRowButton, HistoryContents, HistoryDetail, HistoryEmpty, HistoryFilter, HistoryGroup, HistoryLoading, HistoryRow, HistorySearch,
  HistoryToolbar, SelectionBar,
} from './HistoryList';

type Filter = 'all' | TrashEntry['kind'] | 'expiring';
const KIND_LABEL: Record<TrashEntry['kind'], string> = { thread: 'Thread', page: 'Page', workspace: 'Workspace' };
const KIND_ICON = { thread: MessageSquare, page: FileText, workspace: Folder } as const;
const RETENTION_DAYS = [7, 14, 30, 60, 90];

const identityOf = (entry: Extract<TrashEntry, { kind: 'page' }>) =>
  ({ backendConnectionId: entry.project.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID, workspaceId: entry.project.id, pageId: entry.page.root.id });
const wsStyle = (id: string) => ({ '--ws-accent': workspaceAccent(id) }) as React.CSSProperties;
const fullDate = (ts: number) => ts ? new Date(ts).toLocaleString() : 'Unknown date';
const shortDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Settings › Trash: deleted threads, pages and workspaces, newest first in
 * time groups, with how long Trash keeps threads and a way to empty it.
 * Opening an item shows it read-only as a level of the page.
 */
export function TrashPane({ onNav }: { onNav?: (page: PageId) => void }) {
  const { projects, hydrated, restoreDeletion, purgeDeletionAsync, emptyTrashAsync, revealNode, restoreProject, purgeProject, selectProject } = useChatStore();
  const nodes = useChatNodesSnapshot();
  const { prefs, setPref } = usePrefs();
  const ttl = prefs.trashTTLDays;
  const phone = useSettingsPhone();
  const now = useNow(60_000);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [oldestFirst, setOldestFirst] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [phoneSelecting, setPhoneSelecting] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; anchor: HTMLButtonElement } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageTrash, setPageTrash] = useState<ReadonlyMap<string, PageTrashEntry[]>>(new Map());
  const operation = useRef(false);
  const mounted = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const focusFrame = useRef<number | undefined>(undefined);
  const ttlId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (focusFrame.current) cancelAnimationFrame(focusFrame.current); };
  }, []);
  // The assistant's system workspace keeps its own history out of Trash.
  const workspaces = useMemo(() => withoutSystemWorkspaces(projects), [projects]);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    Promise.all(workspaces.filter(project => !project.deletedAt).map(async project => {
      try {
        return [project.id, await listPageTrash(project.id, { backendConnectionId: project.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID, workspaceId: project.id, signal: controller.signal })] as const;
      } catch { return [project.id, [] as PageTrashEntry[]] as const; }
    })).then(results => { if (live) setPageTrash(new Map(results)); });
    return () => { live = false; controller.abort(); };
  }, [workspaces]);

  const sections = useMemo(() => buildTrashSections(workspaces, nodes), [workspaces, nodes]);
  const pageEntries = useMemo(() => buildPageTrashEntries(workspaces, pageTrash), [workspaces, pageTrash]);
  // A deleted workspace is one item; its own deleted threads open from its detail.
  const listed = useMemo<TrashEntry[]>(() => [
    ...sections.flatMap((section): TrashEntry[] => section.project.deletedAt
      ? [{ kind: 'workspace', ...section }]
      : section.groups.map(group => ({ kind: 'thread', project: section.project, group }))),
    ...pageEntries,
  ], [sections, pageEntries]);
  const lookup = useMemo(() => new Map<string, TrashEntry>([
    ...listed.map(entry => [entryKey(entry), entry] as const),
    ...sections.filter(section => section.project.deletedAt).flatMap(section => section.groups.map(group => {
      const entry: TrashEntry = { kind: 'thread', project: section.project, group };
      return [entryKey(entry), entry] as const;
    })),
  ]), [listed, sections]);
  const total = listed.length;
  const expiring = listed.filter(entry => isExpiringSoon(entry, ttl, now));
  const needle = query.trim().toLocaleLowerCase();
  const visible = listed
    .filter(entry => filter === 'all' || (filter === 'expiring' ? isExpiringSoon(entry, ttl, now) : entry.kind === filter))
    .filter(entry => !needle || [entryTitle(entry), entry.project.name, entry.project.cwd ?? ''].some(text => text.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => (oldestFirst ? 1 : -1) * (entryDeletedAt(a) - entryDeletedAt(b)));
  const detail = detailKey ? lookup.get(detailKey) : undefined;
  const menuEntry = menu ? lookup.get(menu.key) : undefined;
  const shownSelected = visible.filter(entry => selected.has(entryKey(entry)));
  const selecting = phone ? phoneSelecting : shownSelected.length > 0;

  // An item restored or deleted elsewhere leaves the detail and the selection.
  useEffect(() => { if (detailKey && !lookup.has(detailKey)) setDetailKey(null); }, [detailKey, lookup]);
  useEffect(() => {
    setSelected(current => {
      const next = new Set([...current].filter(key => lookup.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [lookup]);

  /** After rows go away, focus the row that took their place, then the search. */
  const focusNearby = (keys: readonly string[]) => {
    const buttons = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-history-open]') ?? []);
    const index = Math.max(0, buttons.findIndex(button => keys.includes(button.dataset.historyOpen ?? '')));
    const candidates = [...buttons.slice(index), ...buttons.slice(0, index).reverse()].map(button => button.dataset.historyOpen).filter(key => !keys.includes(key ?? ''));
    return () => {
      focusFrame.current = requestAnimationFrame(() => {
        if (!mounted.current) return;
        const current = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-history-open]') ?? []);
        const next = candidates.map(key => current.find(button => button.dataset.historyOpen === key)).find(Boolean);
        (next ?? search.current)?.focus({ preventScroll: true });
      });
    };
  };
  const closeDetail = useCallback(() => {
    const key = detailKey;
    setDetailKey(null);
    focusFrame.current = requestAnimationFrame(() => {
      findRowButton(root.current, key)?.focus({ preventScroll: true });
    });
  }, [detailKey]);
  const openDetail = (entry: TrashEntry) => { setMenu(null); setDetailKey(entryKey(entry)); };
  const toggle = (key: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const clearSelection = () => { setSelected(new Set()); setPhoneSelecting(false); };

  /** Put one item back; a thread in a deleted workspace brings the workspace back too. */
  const restoreOne = (entry: TrashEntry): string | null => {
    if (entry.kind === 'page') {
      const identity = identityOf(entry);
      void restorePage(entry.page.root.id, identity).then(() => {
        notifyPageChanged(identity);
        setPageTrash(current => new Map(current).set(entry.project.id, (current.get(entry.project.id) ?? []).filter(item => item.deletionGroupId !== entry.page.deletionGroupId)));
      }).catch(reason => setError(`Could not restore this page: ${reason instanceof Error ? reason.message : 'Request failed'}`));
      return null;
    }
    if (entry.project.deletedAt) restoreProject(entry.project.id);
    return entry.kind === 'thread' ? restoreDeletion(entry.group.id) : null;
  };
  const restore = (entries: readonly TrashEntry[]) => {
    if (operation.current || !entries.length) return;
    const keys = entries.map(entryKey);
    const refocus = detail ? null : focusNearby(keys);
    setMenu(null);
    setError(null);
    const roots = entries.map(restoreOne);
    setSelected(current => new Set([...current].filter(key => !keys.includes(key))));
    if (detail) setDetailKey(null);
    const [only] = entries;
    if (entries.length > 1) toast.success(`${plural(entries.length, 'item')} restored`);
    else if (only.kind === 'page') toast.success('Page restored');
    else toast.success(only.kind === 'thread' ? 'Thread restored' : 'Workspace restored', {
      ...(onNav ? { action: { label: 'Open', onClick: () => {
        // The restored thread is in no slot yet: reveal it in its own thread.
        if (!roots[0] || !revealNode(roots[0], { workspaceId: only.project.id })) selectProject(only.project.id);
        onNav('dashboard');
      } } } : {}),
    });
    if (refocus) refocus();
    else focusFrame.current = requestAnimationFrame(() => search.current?.focus({ preventScroll: true }));
  };
  const purgeOne = async (entry: TrashEntry) => {
    if (entry.kind === 'thread') await purgeDeletionAsync(entry.group.id);
    else if (entry.kind === 'workspace') await purgeProject(entry.project.id);
    else {
      const identity = identityOf(entry);
      await purgePage(entry.page.root.id, identity);
      notifyPageChanged(identity);
      setPageTrash(current => new Map(current).set(entry.project.id, (current.get(entry.project.id) ?? []).filter(item => item.deletionGroupId !== entry.page.deletionGroupId)));
    }
  };
  /** Delete some items, or with none, everything in Trash. Asks first; stops at the first failure. */
  const purge = async (entries?: readonly TrashEntry[]) => {
    if (operation.current) return;
    const trigger = document.activeElement as HTMLElement | null;
    let returnFocus = false;
    // Guard the confirmation as well as the request: persistence only has one pause gate.
    operation.current = true;
    setBusy(true);
    setMenu(null);
    const refocus = focusNearby(entries?.map(entryKey) ?? []);
    const [only] = entries ?? [];
    const message = !entries
      ? `Permanently delete all ${plural(total, 'item')} in Trash, including the contents of deleted workspaces? This cannot be undone.`
      : entries.length > 1
        ? `Permanently delete ${plural(entries.length, 'item')}${entries.some(entry => entry.kind === 'workspace') ? ', including the contents of deleted workspaces' : ''}? This cannot be undone.`
        : `Permanently delete ${only.kind} "${entryTitle(only)}"${only.kind === 'workspace' ? ' and all of its contents' : only.kind === 'thread' ? ` (${plural(only.group.members.length, 'node')})` : ` and ${plural(only.page.pages.length - 1, 'child page')}`}? This cannot be undone.`;
    try {
      const confirmed = await confirmDialog({
        title: !entries ? 'Empty Trash?' : entries.length > 1 ? `Delete ${plural(entries.length, 'item')} permanently?` : 'Delete permanently?',
        message, confirmLabel: !entries ? 'Empty Trash' : 'Delete permanently', danger: true,
      });
      if (!confirmed || !mounted.current) { returnFocus = true; return; }
      setError(null);
      if (entries) {
        for (const entry of entries) {
          await purgeOne(entry);
          if (mounted.current) setSelected(current => { const next = new Set(current); next.delete(entryKey(entry)); return next; });
        }
      } else {
        // Finish thread purges before deleting their parent workspaces.
        await emptyTrashAsync();
        for (const entry of pageEntries) {
          const identity = identityOf(entry);
          await purgePage(entry.page.root.id, identity);
          notifyPageChanged(identity);
        }
        setPageTrash(new Map());
        for (const project of workspaces.filter(project => project.deletedAt)) await purgeProject(project.id);
      }
      if (mounted.current) {
        if (detail) setDetailKey(null);
        toast.success(!entries ? 'Trash emptied' : entries.length > 1 ? `${plural(entries.length, 'item')} permanently deleted` : `${KIND_LABEL[only.kind]} permanently deleted`);
        refocus();
      }
    } catch (reason) {
      if (mounted.current) setError(`Could not ${!entries ? 'empty Trash' : entries.length > 1 ? 'delete every item' : 'delete this item'}: ${reason instanceof Error ? reason.message : 'Request failed'}`);
      returnFocus = true;
    } finally {
      operation.current = false;
      if (mounted.current) {
        // Commit before any queued focus runs: the row buttons are disabled
        // while busy, and focusing a still-disabled button silently fails.
        flushSync(() => setBusy(false));
        if (returnFocus) focusFrame.current = requestAnimationFrame(() => {
          if (mounted.current) (trigger?.isConnected ? trigger : search.current)?.focus({ preventScroll: true });
        });
      }
    }
  };
  /** Shortening retention deletes older threads at once, so that asks first. */
  const changeRetention = async (days: number) => {
    const doomed = days > 0 && (ttl <= 0 || days < ttl) ? groupsPastRetention(sections, days, Date.now()) : [];
    if (doomed.length && !(await confirmDialog({
      title: `Delete ${plural(doomed.length, 'thread')} now?`,
      message: `${doomed.length === 1 ? 'One thread has' : `${doomed.length} threads have`} been in Trash longer than ${plural(days, 'day')}. ${doomed.length === 1 ? 'It is' : 'They are'} deleted permanently as soon as this changes. This cannot be undone.`,
      confirmLabel: 'Delete and change', danger: true,
    }))) return;
    setPref('trashTTLDays', days);
  };

  const retentionOptions = RETENTION_DAYS.includes(ttl) || ttl <= 0 ? RETENTION_DAYS : [...RETENTION_DAYS, ttl].sort((a, b) => a - b);
  const kindCounts = (['thread', 'page', 'workspace'] as const).map(kind => ({ value: kind, label: `${KIND_LABEL[kind]}s`, count: listed.filter(entry => entry.kind === kind).length })).filter(option => option.count > 0);

  const row = (entry: TrashEntry) => {
    const key = entryKey(entry);
    const deletedAt = entryDeletedAt(entry);
    const days = entryRemainingDays(entry, ttl, now);
    const soon = days !== null && days <= 3;
    const meta: React.ReactNode[] = [];
    if (entry.kind !== 'workspace') meta.push(<span className="settings-history__ws" style={wsStyle(entry.project.id)}>{entry.project.name}</span>);
    if (entry.kind === 'thread') meta.push(plural(entry.group.members.length, 'node'), ...(phone ? [] : [plural(entry.group.messageCount, 'message')]));
    else if (entry.kind === 'page') meta.push(plural(entry.page.pages.length, 'page'));
    else meta.push(plural(entry.project.trees.filter(tree => !nodes[tree.rootNodeId]?.deletedAt).length + entry.groups.length, 'thread'), ...(phone || !entry.project.cwd ? [] : [entry.project.cwd]));
    return <HistoryRow key={key} id={key} icon={KIND_ICON[entry.kind]} title={entryTitle(entry)} query={query} meta={meta}
      when={{ label: soon ? (days === 0 ? 'Due today' : `${plural(days, 'day')} left`) : relativeDeletion(deletedAt, now), soon,
        dateTime: deletedAt ? new Date(deletedAt).toISOString() : undefined, title: deletedAt ? `Deleted ${fullDate(deletedAt)}` : undefined }}
      selected={selected.has(key)} selecting={selecting} busy={busy} menuOpen={menu?.key === key}
      primary={{ label: 'Restore', icon: Undo2 }}
      onOpen={() => openDetail(entry)} onToggle={() => toggle(key)} onPrimary={() => restore([entry])}
      onMenu={anchor => setMenu(current => current?.key === key ? null : { key, anchor })} />;
  };

  if (detail) return <div className="settings-history" ref={root} aria-busy={busy}>
    {error && <ErrorBar text={error} onDismiss={() => setError(null)} />}
    <TrashItem key={detailKey} entry={detail} nodes={nodes} ttl={ttl} now={now} busy={busy} onBack={closeDetail}
      onRestore={() => restore([detail])} onDelete={() => { void purge([detail]); }} onOpen={openDetail} />
  </div>;

  let list: React.ReactNode;
  if (!hydrated) list = <HistoryLoading label="Loading Trash" />;
  else if (!total) list = <HistoryEmpty icon={Trash2} title="Trash is empty">
    Deleted threads, pages and workspaces come here first. {ttl > 0 ? `Threads stay ${plural(ttl, 'day')}, then they’re deleted for good.` : 'Nothing is deleted until you empty Trash.'}
  </HistoryEmpty>;
  else if (!visible.length) list = <HistoryEmpty icon={Search} title="No matching items"
    action={<Button size="sm" onClick={() => { setQuery(''); setFilter('all'); search.current?.focus(); }}>Show all items</Button>}>
    {needle ? `Nothing in Trash matches "${query.trim()}".` : 'Nothing of this kind is in Trash.'}
  </HistoryEmpty>;
  else list = groupByBucket(visible, entryDeletedAt, now).map(group => <HistoryGroup key={group.bucket} title={group.bucket} count={group.items.length}>{group.items.map(row)}</HistoryGroup>);

  return <div className="settings-history" ref={root} aria-busy={busy || !hydrated}>
    <p className="settings-history__lede">Deleted threads, pages and workspaces. Restoring puts an item back in its workspace, where it was.</p>
    <SettingsSection title="Cleanup">
      <SettingsRow label="Delete automatically" labelFor={ttlId}
        description="Threads in Trash longer than this are deleted for good. Pages and workspaces stay until you delete them."
        control={<select id={ttlId} className="ui-select settings-row__select" value={ttl > 0 ? ttl : 0} disabled={busy}
          onChange={event => { void changeRetention(Number(event.target.value)); }}>
          {retentionOptions.map(days => <option key={days} value={days}>After {plural(days, 'day')}</option>)}
          <option value={0}>Never</option>
        </select>} />
      <SettingsRow label="Empty Trash"
        description={total ? `Permanently delete all ${plural(total, 'item')}, including what’s inside deleted workspaces.` : 'Nothing to delete.'}
        control={<Button danger disabled={!hydrated || !total || busy} onClick={() => { void purge(); }}>{busy ? 'Working…' : 'Empty Trash…'}</Button>} />
    </SettingsSection>
    {hydrated && total > 0 && <HistoryToolbar selecting={selecting} onClearSelection={clearSelection}>
      {selecting ? <SelectionBar count={shownSelected.length} total={visible.length} onCancel={clearSelection}
        onToggleAll={() => setSelected(shownSelected.length === visible.length ? new Set() : new Set(visible.map(entryKey)))}>
        <Button disabled={busy || !shownSelected.length} onClick={() => restore(shownSelected)}><Undo2 size={13} aria-hidden="true" />Restore</Button>
        <Button danger disabled={busy || !shownSelected.length} onClick={() => { void purge(shownSelected); }}><Trash2 size={13} aria-hidden="true" />{phone ? 'Delete…' : 'Delete permanently…'}</Button>
      </SelectionBar> : <>
        <HistorySearch inputRef={search} value={query} onChange={value => { setQuery(value); setMenu(null); }} label="Search Trash" placeholder="Search Trash" />
        <HistoryFilter label="Show" value={filter === 'expiring' ? 'all' : filter} onChange={value => setFilter(value)}
          options={[{ value: 'all' as const, label: 'All', count: total }, ...kindCounts]} />
        {!phone && <select className="ui-select" aria-label="Sort deleted items" value={oldestFirst ? 'oldest' : 'newest'} onChange={event => setOldestFirst(event.target.value === 'oldest')}>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>}
        {phone && <Button onClick={() => setPhoneSelecting(true)}>Select</Button>}
      </>}
    </HistoryToolbar>}
    {hydrated && total > 0 && (filter === 'expiring'
      ? <div className="settings-history__notice" role="status"><Clock3 size={15} aria-hidden="true" /><span>Showing threads deleted automatically within 3 days.</span><Button size="sm" onClick={() => setFilter('all')}>Show all</Button></div>
      : expiring.length > 0 && <div className="settings-history__notice"><Clock3 size={15} aria-hidden="true" /><span>{plural(expiring.length, 'thread')} will be deleted automatically within 3 days.</span><Button size="sm" onClick={() => setFilter('expiring')}>Show them</Button></div>)}
    {error && <ErrorBar text={error} onDismiss={() => setError(null)} />}
    <div data-history-selecting={selecting || undefined}>{list}</div>
    {menu && menuEntry && !busy && <TrashMenu anchor={menu.anchor} onClose={() => setMenu(null)} onPreview={() => openDetail(menuEntry)}
      onRestore={() => restore([menuEntry])} onDelete={() => { void purge([menuEntry]); }} />}
  </div>;
}

function ErrorBar({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return <div className="settings-history__error" role="alert"><span>{text}</span><TrashIconButton icon={X} tooltip="Dismiss error" aria-label="Dismiss error" onClick={onDismiss} /></div>;
}

function TrashItem({ entry, nodes, ttl, now, busy, onBack, onRestore, onDelete, onOpen }: {
  entry: TrashEntry;
  nodes: ReturnType<typeof useChatNodesSnapshot>;
  ttl: number;
  now: number;
  busy: boolean;
  onBack: () => void;
  onRestore: () => void;
  onDelete: () => void;
  onOpen: (entry: TrashEntry) => void;
}) {
  const days = entryRemainingDays(entry, ttl, now);
  const deletedAt = entryDeletedAt(entry);
  const liveTrees = entry.kind === 'workspace' ? entry.project.trees.filter(tree => !nodes[tree.rootNodeId]?.deletedAt) : [];
  const details = [
    entry.kind === 'workspace'
      ? { label: 'Location', value: entry.project.cwd ? <code>{entry.project.cwd}</code> : 'No folder' }
      : { label: 'Workspace', value: <span className="settings-history__ws" style={wsStyle(entry.project.id)}>{entry.project.name}</span> },
    { label: 'Deleted', value: fullDate(deletedAt) },
    {
      label: 'Deleted for good', soon: days !== null && days <= 3,
      value: entry.kind !== 'thread' ? `Not automatically. ${KIND_LABEL[entry.kind]}s stay until you delete them.`
        : days === null ? 'Not automatically' : `${days === 0 ? 'Today' : `In ${plural(days, 'day')}`} · ${shortDate(entry.group.oldestDeletedAt + ttl * 86_400_000)}`,
    },
    {
      label: 'Contains',
      value: entry.kind === 'thread' ? `${plural(entry.group.members.length, 'node')} · ${plural(entry.group.messageCount, 'message')}`
        : entry.kind === 'page' ? plural(entry.page.pages.length, 'page') : plural(liveTrees.length + entry.groups.length, 'thread'),
    },
  ];
  const noun = entry.kind;
  return <HistoryDetail backLabel="All items" onBack={onBack} icon={KIND_ICON[entry.kind]} kind={KIND_LABEL[entry.kind]} title={entryTitle(entry)} details={details}
    note={entry.kind === 'workspace' ? 'Restores to your workspaces' : `Restores to ${entry.project.name}`}
    actions={<>
      <Button variant="primary" disabled={busy} onClick={onRestore}><Undo2 size={15} aria-hidden="true" />Restore {noun}</Button>
      <Button danger disabled={busy} aria-label={`Delete ${entryTitle(entry)} permanently`} onClick={onDelete}><Trash2 size={15} aria-hidden="true" />Delete permanently…</Button>
    </>}>
    {entry.kind === 'thread' && <>
      <ConversationPreview key={entry.group.root.nodeId} node={entry.group.root}
        messageCount={nodeMessageCount(entry.group.root)} />
      {entry.group.members.length > 1 && <HistoryContents title="Nodes" items={entry.group.members.map(node => ({
        id: node.nodeId, icon: MessageSquare, label: node.title || 'Untitled node', note: node.nodeId === entry.group.root.nodeId ? 'Root' : undefined,
      }))} />}
    </>}
    {entry.kind === 'page' && <>
      <HistoryContents title="Pages" items={entry.page.pages.map(page => ({ id: page.id, icon: FileText, label: page.title, note: page.id === entry.page.root.id && entry.page.pages.length > 1 ? 'Root' : undefined }))} />
      {entry.page.databases.length > 0 && <p className="settings-history__note">Includes {plural(entry.page.databases.length, 'database')} moved to Trash with this page.</p>}
    </>}
    {entry.kind === 'workspace' && (liveTrees.length + entry.groups.length > 0
      ? <HistoryContents title="Threads" items={[
        ...liveTrees.map(tree => ({ id: tree.id, icon: MessageSquare, label: threadDisplayTitle(tree, nodes[tree.rootNodeId], 'Untitled thread'), note: tree.archivedAt ? 'Archived' : undefined })),
        ...entry.groups.map(group => ({
          id: group.id, icon: MessageSquare, note: 'In Trash',
          label: <button type="button" onClick={() => onOpen({ kind: 'thread', project: entry.project, group })}>{group.title}</button>,
        })),
      ]} />
      : <p className="settings-history__note">No threads in this workspace.</p>)}
  </HistoryDetail>;
}
