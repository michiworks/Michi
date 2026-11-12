import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ActionMenu } from '../../ui/ActionMenu';
import { DrawerShell, type DrawerShellProps } from '../../ui/DrawerShell';
import { usePhoneLayout } from '../../../hooks/usePhoneLayout';
import {
  chatLabel,
  shallowArrayEqual,
  useChatProjects,
  useNodesSelector,
} from '../../../state/chatStore';
import type { ChatNodeState } from '../../../state/chatTypes';
import { findTreeIdForNode } from '../../../state/tree';
import {
  selectBackgroundWork,
  threadConversationIds,
  type BackgroundWork,
  type BackgroundWorkKeep,
} from '../../../state/backgroundWork';
import {
  useBackgroundSubagentLiveness,
  useOptionalWorkflowDomain,
  useWorkflowRunsForNodes,
} from '../../../state/workflowDomain';
import type { BackgroundWorkFocus, OpenBackgroundWorkDetail } from './backgroundWorkEvents';
import { MultiModelWorkCard } from './MultiModelWorkCard';
import { SubagentCard } from './SubagentCard';
import { WorkflowWorkCard } from './WorkflowWorkCard';
import { GLYPH_BOX, useFinishedFold } from './workCardParts';

/**
 * Background work: what a conversation's subagents and workflows are doing,
 * in a right drawer. A workflow is a card (what it is, where it is, its
 * controls and approvals, then one line per agent, opened in place; a
 * multi-model run lists its steps with one row per branch); the
 * subagents are one card in the same language (SubagentCard), a line each
 * that expands to its detail (task, steps, result). The header says what
 * needs you and what runs; the scope is a
 * quiet menu beside it. Opened only by a user click (pane-title badge,
 * in-chat card); live while open. Which items it lists is
 * `selectBackgroundWork`; finished work it lists while other work runs
 * folds behind one line, or the subagents' Finished band (`foldedItems`).
 */

type Scope = 'conversation' | 'thread';

const DRAWER_WIDTH = 640;

const ellipsis: React.CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

const BODY: React.CSSProperties = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' };

function itemKey(nodeId: string, focus: BackgroundWorkFocus): string {
  return JSON.stringify([nodeId, focus.kind, focus.kind === 'subagent' ? focus.sessionId : focus.runKey]);
}

/** An item the drawer lists: its conversation and the item. */
interface ListedItem {
  nodeId: string;
  focus: BackgroundWorkFocus;
}

function parseItemKey(key: string): ListedItem | null {
  try {
    const [nodeId, kind, id] = JSON.parse(key) as unknown[];
    if (typeof nodeId !== 'string' || typeof id !== 'string') return null;
    if (kind === 'subagent') return { nodeId, focus: { kind, sessionId: id } };
    if (kind === 'workflow') return { nodeId, focus: { kind, runKey: id } };
  } catch {
    // Not an item key.
  }
  return null;
}

/** selectBackgroundWork's `keep`, per conversation. */
function keepByNode(items: Iterable<ListedItem>): Map<string, BackgroundWorkKeep> {
  const byNode = new Map<string, { subagentIds: Set<string>; runKeys: Set<string> }>();
  for (const { nodeId, focus } of items) {
    let keep = byNode.get(nodeId);
    if (!keep) {
      keep = { subagentIds: new Set(), runKeys: new Set() };
      byNode.set(nodeId, keep);
    }
    if (focus.kind === 'subagent') keep.subagentIds.add(focus.sessionId);
    else keep.runKeys.add(focus.runKey);
  }
  return byNode;
}

/** Items listed since the current open request (see the drawer's sticky ref). */
interface StickyItems {
  /** The request's requestSeq. */
  token: number;
  items: Map<string, ListedItem>;
  /** Item keys `foldedItems` folded when they were first listed. */
  folded: Set<string>;
}

interface WorkGroupValue {
  node: ChatNodeState;
  title: string;
  loading: boolean;
  current: boolean;
  work: BackgroundWork;
  /** Item keys behind the section's fold line (foldedItems). */
  folded: ReadonlySet<string>;
}

/**
 * Which listed items fold behind their section's "N finished" line: the
 * ones already finished when the drawer first lists them under the current
 * request while other items in their section run. Decided once per item,
 * like the sticky items: one the drawer listed unfolded stays in view (an
 * agent that finishes while the user watches does not slide out of
 * sight), and a new running item does not fold what was already showing.
 * Opening again decides afresh.
 */
function foldedItems(nodeId: string, work: BackgroundWork, sticky: StickyItems | undefined): ReadonlySet<string> {
  const folded = new Set<string>();
  const decide = (key: string, active: boolean, sectionRunning: boolean) => {
    const fold = sticky?.items.has(key) ? sticky.folded.has(key) : !active && sectionRunning;
    if (fold) folded.add(key);
  };
  const subagentsRunning = work.subagents.some((item) => item.active);
  for (const item of work.subagents) {
    decide(itemKey(nodeId, { kind: 'subagent', sessionId: item.subagent.sessionId }), item.active, subagentsRunning);
  }
  const workflowsRunning = work.workflows.some((item) => item.active);
  for (const item of work.workflows) {
    decide(itemKey(nodeId, { kind: 'workflow', runKey: item.runKey }), item.active, workflowsRunning);
  }
  return folded;
}

function runningCount(work: BackgroundWork): number {
  return work.subagents.filter((item) => item.active).length + work.workflows.filter((item) => item.active).length;
}

const rowButton: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '6px 8px',
  border: 0,
  borderRadius: 'var(--ui-radius)',
  margin: 0,
  background: 'transparent',
  color: 'var(--term-fg)',
  font: 'inherit',
  fontFamily: 'var(--ui-font)',
  textAlign: 'left',
  cursor: 'pointer',
};

function FoldLine({ count, failed, noun, open, controls, onClick }: {
  count: number;
  failed: number;
  noun: string;
  open: boolean;
  controls: string;
  onClick: () => void;
}) {
  const stacked = usePhoneLayout();
  return (
    <button
      type="button"
      data-testid="background-work-fold"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={`${count} finished ${noun}${failed > 0 ? `, ${failed} failed` : ''}`}
      onClick={onClick}
      className="t-hover-bg-alt"
      // A finger-sized target on a phone.
      style={stacked ? { ...rowButton, padding: 8 } : rowButton}
    >
      <span aria-hidden style={{ ...GLYPH_BOX, fontSize: 'var(--fs-xs)', color: 'var(--term-faint)' }}>{open ? '▾' : '▸'}</span>
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>{count} finished</span>
      {failed > 0 && <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-danger-text)' }}>· {failed} failed</span>}
    </button>
  );
}

/**
 * A conversation's workflow cards: the running ones, then finished ones,
 * those `foldedItems` picked behind one line (useFinishedFold). Workflow
 * cards say what they are, so their section has no label. The subagents
 * fold the same way, behind their card's Finished band.
 */
function WorkSection<T extends { active: boolean }>({ noun, items, keyOf, isFailed, renderItem, folded, foldKey, foldOpen, onSetFold, expandedKey, onToggle, gap = 0 }: {
  /** The fold line's noun: "workflows". */
  noun: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  isFailed: (item: T) => boolean;
  renderItem: (item: T, key: string) => React.ReactNode;
  folded: ReadonlySet<string>;
  foldKey: string;
  foldOpen: boolean;
  onSetFold: (key: string, open: boolean) => void;
  expandedKey: string | null;
  onToggle: (key: string) => void;
  /** Space between items (cards). */
  gap?: number;
}) {
  const listId = useId();
  const { inline, tucked, folds, open, toggle } = useFinishedFold({ items, keyOf, folded, foldKey, foldOpen, onSetFold, expandedKey, onToggle });
  const list: React.CSSProperties | undefined = gap ? { display: 'flex', flexDirection: 'column', gap } : undefined;
  return (
    <>
      <div style={list}>{inline.map(({ item, key }) => renderItem(item, key))}</div>
      {folds && (
        <>
          <div style={gap ? { marginTop: gap / 2 } : undefined}>
            <FoldLine
              count={tucked.length}
              failed={tucked.filter(({ item }) => isFailed(item)).length}
              noun={noun}
              open={open}
              controls={listId}
              onClick={toggle}
            />
          </div>
          {open && <div id={listId} style={list}>{tucked.map(({ item, key }) => renderItem(item, key))}</div>}
        </>
      )}
    </>
  );
}

/** The row of a multi-model run the open request names (a click on a row of its in-chat card), with the request's requestSeq. */
type RowFocus = { key: string; threadKey: string; step?: number; seq: number };

function WorkGroup({ group, showHeader, expandedKey, onToggle, openFolds, onSetFold, rowFocus, onClose, onMenuOpenChange }: {
  group: WorkGroupValue;
  showHeader: boolean;
  expandedKey: string | null;
  onToggle: (key: string) => void;
  openFolds: ReadonlySet<string>;
  onSetFold: (key: string, open: boolean) => void;
  rowFocus: RowFocus | null;
  /** Closes the drawer: it is modal, so a pane an item opens stays hidden behind it otherwise. */
  onClose: () => void;
  /** An item's own menu opened or closed (Escape closes that menu first). */
  onMenuOpenChange: (open: boolean) => void;
}) {
  const { node, work, loading, folded } = group;
  const empty = work.subagents.length === 0 && work.workflows.length === 0;
  const subagentsFold = JSON.stringify([node.nodeId, 'subagents']);
  // The subagents' list band is open unless closed: what it records is the closing.
  const subagentsClosed = JSON.stringify([node.nodeId, 'subagents', 'closed']);
  const workflowsFold = JSON.stringify([node.nodeId, 'workflows']);
  return (
    <section data-testid="background-work-group" data-node-id={node.nodeId} aria-label={showHeader ? group.title : undefined} style={{ paddingBottom: showHeader ? 18 : 6 }}>
      {showHeader && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '4px 2px 10px', minWidth: 0 }}>
          <span data-testid="background-work-group-title" style={{ ...ellipsis, fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--term-fg)' }}>{group.title}</span>
          {group.current && <span style={{ flexShrink: 0, fontSize: 'var(--fs-xs)', color: 'var(--term-muted)' }}>this conversation</span>}
        </div>
      )}
      {loading && empty && (
        <div role="status" className="term-hydrating" style={{ padding: '4px 8px', fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>loading…</div>
      )}
      {work.workflows.length > 0 && (
        <WorkSection
          noun="workflows"
          items={work.workflows}
          keyOf={(item) => itemKey(node.nodeId, { kind: 'workflow', runKey: item.runKey })}
          isFailed={(item) => item.run.value.status === 'failed'}
          renderItem={(item, key) => (item.run.value.runtime === 'michi'
            ? <MultiModelWorkCard key={key} runKey={item.runKey} rowKey={key} expanded={expandedKey === key}
              focus={rowFocus?.key === key ? rowFocus : undefined} onClose={onClose} onMenuOpenChange={onMenuOpenChange} />
            : <WorkflowWorkCard key={key} runKey={item.runKey} rowKey={key} expanded={expandedKey === key} onToggle={onToggle} />)}
          folded={folded}
          foldKey={workflowsFold}
          foldOpen={openFolds.has(workflowsFold)}
          onSetFold={onSetFold}
          expandedKey={expandedKey}
          onToggle={onToggle}
          gap={12}
        />
      )}
      {work.subagents.length > 0 && (
        <div style={work.workflows.length > 0 ? { marginTop: 12 } : undefined}>
          <SubagentCard
            items={work.subagents}
            keyOf={(item) => itemKey(node.nodeId, { kind: 'subagent', sessionId: item.subagent.sessionId })}
            folded={folded}
            foldKey={subagentsFold}
            listKey={subagentsClosed}
            openFolds={openFolds}
            onSetFold={onSetFold}
            expandedKey={expandedKey}
            onToggle={onToggle}
          />
        </div>
      )}
    </section>
  );
}

const NO_FOLDS: ReadonlySet<string> = new Set();

const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: 'conversation', label: 'This conversation' },
  { value: 'thread', label: 'Whole thread' },
];

/** The scope, as a quiet menu beside the title: secondary to what it lists. */
function ScopeMenu({ scope, onChange, open, onOpenChange, phone }: {
  scope: Scope;
  onChange: (scope: Scope) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  phone: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const label = SCOPES.find((entry) => entry.value === scope)?.label ?? '';
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Show background work for: ${label}`}
        onClick={() => onOpenChange(!open)}
        className="t-hover-bg-alt"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
          border: 0, borderRadius: 'var(--ui-radius)',
          // A finger-sized target on a phone.
          padding: phone ? '8px 10px' : '4px 7px',
          background: open ? 'var(--term-alt)' : 'transparent',
          color: open ? 'var(--term-fg)' : 'var(--term-muted)',
          fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-sm)', whiteSpace: 'nowrap', cursor: 'pointer',
        }}
      >
        {label}
        <span aria-hidden style={{ fontSize: 'var(--fs-2xs)' }}>▾</span>
      </button>
      {open && anchor.current && (
        <ActionMenu
          anchor={anchor.current}
          onClose={() => onOpenChange(false)}
          label="Show background work for"
          width={208}
          items={SCOPES.map(({ value, label: text }) => ({
            id: value,
            label: text,
            checked: value === scope,
            icon: <span aria-hidden style={{ width: 14, flexShrink: 0, display: 'inline-flex', justifyContent: 'center', color: 'var(--term-accent)' }}>{value === scope ? '✓' : ''}</span>,
            onSelect: () => onChange(value),
          }))}
        />
      )}
    </>
  );
}

export interface BackgroundWorkDrawerProps extends Pick<DrawerShellProps, 'open' | 'onClose' | 'motion' | 'onPresenceChange'> {
  request: OpenBackgroundWorkDetail;
  /** Bumps on every open request, so opening again re-applies its focus. */
  requestSeq: number;
}

export default function BackgroundWorkDrawer({ open, onClose, motion, onPresenceChange, request, requestSeq }: BackgroundWorkDrawerProps) {
  const { activeProject } = useChatProjects();
  const focusKey = request.focus ? itemKey(request.nodeId, request.focus) : null;
  const [scope, setScope] = useState<Scope>('conversation');
  const [expandedKey, setExpandedKey] = useState<string | null>(focusKey);
  // Fold lines and subagent bands the user (or an expanded item) opened, and the subagents' list band they closed.
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(NO_FOLDS);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  // Item menus open now (a multi-model card's Replace model): Escape is theirs while any is.
  const [itemMenus, setItemMenus] = useState(0);
  const onItemMenuOpenChange = useCallback((value: boolean) => setItemMenus((count) => count + (value ? 1 : -1)), []);
  const [appliedSeq, setAppliedSeq] = useState(requestSeq);
  if (appliedSeq !== requestSeq) {
    // A new open request: back to its conversation, its focus expanded.
    setAppliedSeq(requestSeq);
    setScope('conversation');
    setScopeMenuOpen(false);
    setExpandedKey(focusKey);
    setOpenFolds(NO_FOLDS);
  }
  const onSetFold = useCallback((key: string, value: boolean) => setOpenFolds((current) => {
    if (current.has(key) === value) return current;
    const next = new Set(current);
    if (value) next.add(key);
    else next.delete(key);
    return next;
  }), []);

  // The history rule applies when the drawer opens: what it has listed since
  // the current request stays listed while it stays open, so an item the
  // user reads does not vanish the moment it finishes, nor when the scope
  // switches and back (items are per conversation; keepByNode applies them
  // only to the conversations listed). A ref, not state: recording what was
  // listed must not re-render.
  const stickyToken = requestSeq;
  const sticky = useRef<StickyItems>({ token: stickyToken, items: new Map(), folded: new Set() });
  if (sticky.current.token !== stickyToken) sticky.current = { token: stickyToken, items: new Map(), folded: new Set() };

  const requestNodeId = request.nodeId;
  // The thread of the requested conversation, whichever thread is active.
  const rootNodeId = useMemo(() => {
    if (!activeProject) return null;
    const treeId = findTreeIdForNode(requestNodeId, activeProject);
    return activeProject.trees.find((tree) => tree.id === treeId)?.rootNodeId ?? null;
  }, [activeProject, requestNodeId]);
  const edges = activeProject?.edges;
  const selectNodes = useCallback((nodes: Record<string, ChatNodeState>) => {
    const ids = scope === 'thread' ? threadConversationIds(rootNodeId, edges ?? [], nodes) : [requestNodeId];
    return ids.flatMap((id) => {
      const node = nodes[id];
      return node && !node.deletedAt && node.kind === 'chat' ? [node] : [];
    });
  }, [scope, rootNodeId, edges, requestNodeId]);
  const nodes = useNodesSelector(selectNodes, shallowArrayEqual);
  const idsKey = nodes.map((node) => node.nodeId).join('\u0000');
  const nodeIds = useMemo(() => (idsKey ? idsKey.split('\u0000') : []), [idsKey]);
  const runs = useWorkflowRunsForNodes(nodeIds);
  // Which background agents a live process still tracks (same feed).
  const liveness = useBackgroundSubagentLiveness();

  // Keep the workspace's workflow runs live while the drawer is open (the
  // subscription is shared with the dashboard's).
  const subscribeWorkspace = useOptionalWorkflowDomain()?.subscribeWorkspace;
  const workspaceId = activeProject?.id;
  useEffect(() => {
    if (!open || !workspaceId || !subscribeWorkspace) return;
    return subscribeWorkspace(workspaceId);
  }, [open, workspaceId, subscribeWorkspace]);

  const requestFocus = request.focus;
  const rowFocus = useMemo<RowFocus | null>(() => (
    focusKey && requestFocus?.kind === 'workflow' && requestFocus.threadKey !== undefined
      ? { key: focusKey, threadKey: requestFocus.threadKey, step: requestFocus.step, seq: requestSeq }
      : null
  ), [focusKey, requestFocus, requestSeq]);
  const groups = useMemo<WorkGroupValue[]>(() => {
    const listed = sticky.current.token === stickyToken ? sticky.current : undefined;
    const kept: ListedItem[] = listed ? [...listed.items.values()] : [];
    if (requestFocus) kept.push({ nodeId: requestNodeId, focus: requestFocus });
    const expanded = expandedKey ? parseItemKey(expandedKey) : null;
    if (expanded) kept.push(expanded);
    const keep = keepByNode(kept);
    return nodes.map((node) => {
      const work = selectBackgroundWork(node, runs, keep.get(node.nodeId), liveness(node.projectId, node.nodeId));
      return {
        node,
        title: node.title || chatLabel(node),
        loading: node.messagesLoaded === false,
        current: node.nodeId === requestNodeId,
        work,
        folded: foldedItems(node.nodeId, work, listed),
      };
    });
  }, [nodes, runs, liveness, requestFocus, requestNodeId, expandedKey, stickyToken]);
  useEffect(() => {
    const current = sticky.current;
    if (current.token !== stickyToken) return;
    const record = (nodeId: string, focus: BackgroundWorkFocus, folded: ReadonlySet<string>) => {
      const key = itemKey(nodeId, focus);
      if (current.items.has(key)) return;
      current.items.set(key, { nodeId, focus });
      if (folded.has(key)) current.folded.add(key);
    };
    for (const { node, work, folded } of groups) {
      for (const item of work.subagents) record(node.nodeId, { kind: 'subagent', sessionId: item.subagent.sessionId }, folded);
      for (const item of work.workflows) record(node.nodeId, { kind: 'workflow', runKey: item.runKey }, folded);
    }
  }, [groups, stickyToken]);
  const shown = scope === 'thread'
    ? groups.filter((group) => group.loading || group.work.subagents.length > 0 || group.work.workflows.length > 0)
    : groups;
  const running = groups.reduce((sum, group) => sum + runningCount(group.work), 0);
  // Runs that wait on an approval: the header says these first.
  const waiting = groups.reduce((sum, group) => sum + group.work.workflows.filter((item) => (item.run.value.approvals?.length ?? 0) > 0).length, 0);
  const nothing = shown.every((group) => !group.loading && group.work.subagents.length === 0 && group.work.workflows.length === 0);

  const onToggle = useCallback((key: string) => setExpandedKey((current) => (current === key ? null : key)), []);

  // Scroll the focused item into view once per request, as soon as it is
  // rendered (its conversation may still be loading when the drawer opens).
  // A ref, not state: store pushes can re-render before a state reset lands.
  const listRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!open || !focusKey) return;
    const token = `${requestSeq}\u0000${focusKey}`;
    if (scrolledFor.current === token) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-background-work-key]') ?? [];
    const row = Array.from(rows).find((element) => element.dataset.backgroundWorkKey === focusKey);
    if (!row) return;
    scrolledFor.current = token;
    row.scrollIntoView?.({ block: 'start' });
  }, [open, focusKey, requestSeq, groups]);

  const phone = usePhoneLayout();

  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      motion={motion}
      onPresenceChange={onPresenceChange}
      title="Background work"
      width={DRAWER_WIDTH}
      closeOnEscape={itemMenus === 0}
      titleBadge={running > 0 || waiting > 0 ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 'var(--fs-sm)', fontFamily: 'var(--ui-font)', whiteSpace: 'nowrap' }}>
          {waiting > 0 && (
            <span data-testid="background-work-waiting" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--term-select)' }}>
              <span aria-hidden className="term-dot-i" style={{ background: 'var(--term-select)', opacity: 1 }} />{waiting} needs you
            </span>
          )}
          {running > 0 && (
            <span data-testid="background-work-running" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--term-muted)' }}>
              {running} running
            </span>
          )}
        </span>
      ) : undefined}
      headerActions={<ScopeMenu scope={scope} onChange={setScope} open={scopeMenuOpen} onOpenChange={setScopeMenuOpen} phone={phone} />}
    >
      <div data-testid="background-work-body" style={BODY}>
        <div ref={listRef} data-testid="background-work-list" className="term-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 14px 24px' }}>
          {nothing ? (
            <div style={{ padding: '28px 18px', textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 'var(--fs-md)', color: 'var(--term-mid)' }}>
                {scope === 'thread' ? 'Nothing is running in this thread.' : 'Nothing is running in this conversation.'}
              </span>
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--term-muted)' }}>
                Subagents and workflows an agent starts show up here while they run, along with everything from its latest reply.
              </span>
            </div>
          ) : shown.map((group) => (
            <WorkGroup key={group.node.nodeId} group={group} showHeader={scope === 'thread'} expandedKey={expandedKey} onToggle={onToggle} openFolds={openFolds} onSetFold={onSetFold}
              rowFocus={rowFocus} onClose={onClose} onMenuOpenChange={onItemMenuOpenChange} />
          ))}
        </div>
      </div>
    </DrawerShell>
  );
}
