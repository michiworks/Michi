import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Eye, GitBranch, MessageSquare, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useChatStore, useChatNodesSnapshot } from '../../../../state/chatStore';
import type { PageId } from '../../../../state/commands';
import { withoutSystemWorkspaces } from '../../../../state/assistant/systemWorkspace';
import { nodeMessageCount } from '../../../../state/nodeMessageCount';
import { initialOf, workspaceAccent } from '../../workspaceAccent';
import { ActionMenu } from '../../../ui/ActionMenu';
import { Button } from '../../../ui/controls';
import { plural } from 'michi-shared';
import { relativeDeletion } from '../trashModel';
import { useSettingsPhone } from './settingsPhone';
import { useNow } from '../../../../hooks/useNow';
import { buildArchiveEntries, groupArchiveEntries, type ArchiveEntry, type ArchiveSort } from './archiveModel';
import {
  ConversationPreview, findRowButton, HistoryDetail, HistoryEmpty, HistoryGroup, HistoryLoading, HistoryRow, HistorySearch, HistoryToolbar, SelectionBar,
} from './HistoryList';

const wsStyle = (id: string) => ({ '--ws-accent': workspaceAccent(id) }) as React.CSSProperties;
const noun = (entry: ArchiveEntry) => entry.kind === 'tree' ? 'Thread' : 'Node';

/**
 * Settings › Archived: threads and single nodes archived out of the sidebar,
 * by workspace. They keep everything and never expire; Unarchive puts one
 * back, and Move to Trash hands it to Trash's retention.
 */
export function ArchivedPane({ onNav }: { onNav?: (page: PageId) => void }) {
  const { projects, hydrated, restoreDeletion, moveDeletionGroupLane, unarchiveTree, deleteTree, revealNode, selectProject, activateTree } = useChatStore();
  const nodes = useChatNodesSnapshot();
  const phone = useSettingsPhone();
  const now = useNow(60_000);
  const [query, setQuery] = useState('');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [sort, setSort] = useState<ArchiveSort>('newest');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [phoneSelecting, setPhoneSelecting] = useState(false);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; anchor: HTMLButtonElement } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const focusFrame = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (focusFrame.current) cancelAnimationFrame(focusFrame.current); }, []);

  // The assistant's system workspace keeps its own history out of this list.
  const workspaces = useMemo(() => withoutSystemWorkspaces(projects).filter(project => !project.deletedAt), [projects]);
  const entries = useMemo(() => buildArchiveEntries(workspaces, nodes), [workspaces, nodes]);
  const lookup = useMemo(() => new Map(entries.map(entry => [entry.key, entry])), [entries]);
  const archivedIn = useMemo(() => {
    const seen = new Map(entries.map(entry => [entry.project.id, entry.project]));
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [entries]);
  const shownWorkspace = workspaceId && archivedIn.some(project => project.id === workspaceId) ? workspaceId : null;
  const { matching, groups } = groupArchiveEntries(entries, { query, workspaceId: shownWorkspace, sort });
  const detail = detailKey ? lookup.get(detailKey) : undefined;
  const menuEntry = menu ? lookup.get(menu.key) : undefined;
  const shownSelected = matching.filter(entry => selected.has(entry.key));
  const selecting = phone ? phoneSelecting : shownSelected.length > 0;

  useEffect(() => { if (detailKey && !lookup.has(detailKey)) setDetailKey(null); }, [detailKey, lookup]);
  useEffect(() => {
    setSelected(current => {
      const next = new Set([...current].filter(key => lookup.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [lookup]);

  const focusSoon = (key: string | null) => {
    focusFrame.current = requestAnimationFrame(() => {
      const row = findRowButton(root.current, key);
      (row ?? root.current?.querySelector<HTMLButtonElement>('[data-history-open]') ?? search.current)?.focus({ preventScroll: true });
    });
  };
  const closeDetail = useCallback(() => {
    const key = detailKey;
    setDetailKey(null);
    focusFrame.current = requestAnimationFrame(() => {
      findRowButton(root.current, key)?.focus({ preventScroll: true });
    });
  }, [detailKey]);
  const openDetail = (entry: ArchiveEntry) => { setMenu(null); setDetailKey(entry.key); };
  const toggle = (key: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const clearSelection = () => { setSelected(new Set()); setPhoneSelecting(false); };
  const leave = (keys: readonly string[]) => {
    setMenu(null);
    setSelected(current => new Set([...current].filter(key => !keys.includes(key))));
    if (detail) setDetailKey(null);
    focusSoon(null);
  };

  const unarchive = (items: readonly ArchiveEntry[]) => {
    if (!items.length) return;
    const restored = items.map(entry => {
      if (entry.kind === 'tree') { unarchiveTree(entry.treeId); return entry.root?.nodeId ?? null; }
      return restoreDeletion(entry.groupId);
    });
    leave(items.map(entry => entry.key));
    const [only] = items;
    if (items.length > 1) { toast.success(`${plural(items.length, 'item')} unarchived`); return; }
    toast.success(`${noun(only)} unarchived`, onNav ? {
      action: { label: 'Open', onClick: () => {
        if (only.kind === 'tree') {
          selectProject(only.project.id);
          activateTree(only.treeId, only.project.id);
        } else if (!restored[0] || !revealNode(restored[0], { workspaceId: only.project.id })) {
          selectProject(only.project.id);
        }
        onNav('dashboard');
      } },
    } : undefined);
  };
  /** Trash keeps it for its retention period; Undo puts it back in Archived. */
  const moveToTrash = (items: readonly ArchiveEntry[]) => {
    const moved = items.flatMap(entry => {
      const groupId = entry.kind === 'tree' ? deleteTree(entry.treeId) : moveDeletionGroupLane(entry.groupId, 'trash');
      return groupId ? [{ entry, groupId }] : [];
    });
    if (!moved.length) return;
    leave(moved.map(({ entry }) => entry.key));
    toast.success(moved.length === 1 ? 'Moved to Trash' : `${plural(moved.length, 'item')} moved to Trash`, {
      action: { label: 'Undo', onClick: () => {
        // A thread keeps its archived mark while in Trash, so restoring it lands in Archived.
        for (const { entry, groupId } of moved) {
          if (entry.kind === 'tree') restoreDeletion(groupId);
          else moveDeletionGroupLane(groupId, 'archive', entry.archivedAt);
        }
      } },
    });
  };

  const row = (entry: ArchiveEntry) => <HistoryRow key={entry.key} id={entry.key} icon={entry.kind === 'tree' ? MessageSquare : GitBranch} title={entry.title} query={query}
    meta={entry.kind === 'node'
      ? [entry.fromTitle ? `Node from “${entry.fromTitle}”` : 'Archived node', ...(phone ? [] : [plural(entry.messageCount, 'message')])]
      : [plural(entry.nodeCount, 'node'), ...(phone ? [] : [plural(entry.messageCount, 'message')])]}
    when={{ label: relativeDeletion(entry.archivedAt, now), dateTime: entry.archivedAt ? new Date(entry.archivedAt).toISOString() : undefined,
      title: entry.archivedAt ? `Archived ${new Date(entry.archivedAt).toLocaleString()}` : undefined }}
    selected={selected.has(entry.key)} selecting={selecting} busy={false} menuOpen={menu?.key === entry.key}
    primary={{ label: 'Unarchive', icon: ArchiveRestore }}
    onOpen={() => openDetail(entry)} onToggle={() => toggle(entry.key)} onPrimary={() => unarchive([entry])}
    onMenu={anchor => setMenu(current => current?.key === entry.key ? null : { key: entry.key, anchor })} />;

  if (detail) return <div className="settings-history" ref={root}>
    <HistoryDetail key={detail.key} backLabel="All archived" onBack={closeDetail} icon={detail.kind === 'tree' ? MessageSquare : GitBranch} kind={noun(detail)} title={detail.title}
      note={`Returns to ${detail.project.name}`}
      details={[
        { label: 'Workspace', value: <span className="settings-history__ws" style={wsStyle(detail.project.id)}>{detail.project.name}</span> },
        { label: 'Archived', value: detail.archivedAt ? new Date(detail.archivedAt).toLocaleString() : 'Unknown date' },
        ...(detail.kind === 'node' ? [{ label: 'Archived from', value: detail.fromTitle ? `“${detail.fromTitle}”. Unarchiving puts the node back under its parent.` : 'Unarchiving puts the node back where it was.' }] : []),
        { label: 'Contains', value: `${plural(detail.nodeCount, 'node')} · ${plural(detail.messageCount, 'message')}` },
      ]}
      actions={<>
        <Button variant="primary" onClick={() => unarchive([detail])}><ArchiveRestore size={15} aria-hidden="true" />Unarchive</Button>
        <Button onClick={() => moveToTrash([detail])}><Trash2 size={15} aria-hidden="true" />Move to Trash</Button>
      </>}>
      {detail.root && <ConversationPreview key={detail.root.nodeId} node={detail.root}
        messageCount={nodeMessageCount(detail.root)} />}
    </HistoryDetail>
  </div>;

  let list: React.ReactNode;
  if (!hydrated) list = <HistoryLoading label="Loading archived threads" />;
  else if (!entries.length) list = <HistoryEmpty icon={Archive} title="Nothing archived">
    Archive a thread from its menu in the sidebar to keep it out of the way without deleting it. Archived threads never expire.
  </HistoryEmpty>;
  else if (!matching.length) list = <HistoryEmpty icon={Search} title="No matching threads"
    action={<Button size="sm" onClick={() => { setQuery(''); setWorkspaceId(null); search.current?.focus(); }}>Show all threads</Button>}>
    {`Nothing archived matches "${query.trim()}".`}
  </HistoryEmpty>;
  else list = groups.map(group => <HistoryGroup key={group.project.id} title={group.project.name} count={group.entries.length}
    badge={<span className="settings-history__badge" style={wsStyle(group.project.id)} aria-hidden="true">{initialOf(group.project.name)}</span>}>
    {group.entries.map(row)}
  </HistoryGroup>);

  return <div className="settings-history" ref={root} aria-busy={!hydrated}>
    <p className="settings-history__lede">Threads you archived are out of the sidebar but keep everything, and they never expire. Unarchive one to put it back in its workspace.</p>
    {hydrated && entries.length > 0 && <HistoryToolbar selecting={selecting} onClearSelection={clearSelection}>
      {selecting ? <SelectionBar count={shownSelected.length} total={matching.length} onCancel={clearSelection}
        onToggleAll={() => setSelected(shownSelected.length === matching.length ? new Set() : new Set(matching.map(entry => entry.key)))}>
        <Button disabled={!shownSelected.length} onClick={() => unarchive(shownSelected)}><ArchiveRestore size={13} aria-hidden="true" />Unarchive</Button>
        <Button disabled={!shownSelected.length} onClick={() => moveToTrash(shownSelected)}><Trash2 size={13} aria-hidden="true" />Move to Trash</Button>
      </SelectionBar> : <>
        <HistorySearch inputRef={search} value={query} onChange={value => { setQuery(value); setMenu(null); }} label="Search archived threads" placeholder="Search archived threads" />
        {archivedIn.length > 1 && <select className="ui-select" aria-label="Workspace" value={shownWorkspace ?? ''} onChange={event => setWorkspaceId(event.target.value || null)}>
          <option value="">All workspaces</option>
          {archivedIn.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>}
        {!phone && <select className="ui-select" aria-label="Sort archived threads" value={sort} onChange={event => setSort(event.target.value as ArchiveSort)}>
          <option value="newest">Recently archived</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name</option>
        </select>}
        {phone && <Button onClick={() => setPhoneSelecting(true)}>Select</Button>}
      </>}
    </HistoryToolbar>}
    <div data-history-selecting={selecting || undefined}>{list}</div>
    {menu && menuEntry && <ActionMenu anchor={menu.anchor} onClose={() => setMenu(null)} label="Archived actions" items={[
      { id: 'preview', label: 'Preview', icon: <Eye size={14} aria-hidden="true" />, onSelect: () => openDetail(menuEntry) },
      { id: 'unarchive', label: 'Unarchive', icon: <ArchiveRestore size={14} aria-hidden="true" />, onSelect: () => unarchive([menuEntry]) },
      { id: 'trash', label: 'Move to Trash', icon: <Trash2 size={14} aria-hidden="true" />, dividerBefore: true, onSelect: () => moveToTrash([menuEntry]) },
    ]} />}
  </div>;
}
