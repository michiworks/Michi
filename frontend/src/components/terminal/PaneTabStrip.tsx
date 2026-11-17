import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import {
  shallowArrayEqual,
  useChatActions,
  useChatPanes,
  useStructuralSelector,
} from '../../state/chatStore';
import type { PaneItemKind } from '../../state/paneItems';
import { paneTitle } from '../../state/paneLabels';
import { useCloseOtherPanes } from '../../state/closeOtherPanes';
import ContextMenu, { menuOpenKey } from '../ContextMenu';
import { Dot } from './primitives';
import PaneLauncher from './PaneLauncher';
import { TemporaryChatGlyph } from './TemporaryChat';
import { AgentRunGlyph, ChatIcon, CloseIcon, MoreIcon } from './icons';
import { tabStripKeyTarget } from './tabKeys';
import { kbd } from '../../lib/platform';

const TAB_DRAG_MIME = 'application/x-michi-tab-id';

type TabKind = PaneItemKind | 'chat' | 'digest';

const KIND_GLYPH: Partial<Record<TabKind, string>> = {
  launcher: '+',
  files: '▱',
  review: '±',
  file: '▤',
  diff: '±',
  terminal: '>_',
  digest: '§',
};

function TabIcon({ kind, status, temporary }: { kind: TabKind; status: string; temporary: boolean }) {
  if (status === 'streaming') return <Dot color="var(--term-run)" size={7} pulse />;
  if (status === 'error') return <Dot color="var(--term-danger)" size={7} />;
  if (kind === 'agent-run') return <AgentRunGlyph style={{ flexShrink: 0 }} />;
  const glyph = KIND_GLYPH[kind];
  // A temporary chat's ghost, before its title, stands in for the chat glyph.
  if (!glyph) return temporary ? null : <ChatIcon style={{ flexShrink: 0 }} />;
  return (
    <span aria-hidden style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', fontWeight: 700, flexShrink: 0 }}>
      {glyph}
    </span>
  );
}

/**
 * Single-page mode's browser-style tab bar: one tab per pane in the active
 * tree's slot. Only the focused tab's pane is shown below it.
 */
export default function PaneTabStrip({ titleOverride, leftInset }: {
  /** Fixed title for every tab (the assistant's hidden workspace). */
  titleOverride?: string;
  /** Clearance for the floating Zone 1 cluster when the sidebar is collapsed. */
  leftInset: number;
}) {
  const { tabPanes = [], focusedPane, paneItems = {} } = useChatPanes();
  const { focusPane, closePane, reorderPane } = useChatActions();

  const titles = useStructuralSelector(
    (nodesMap) => tabPanes.map((id) => paneTitle(nodesMap[id], paneItems[id], { override: titleOverride })),
    shallowArrayEqual,
  );
  const statuses = useStructuralSelector(
    (nodesMap) => tabPanes.map((id) => {
      const node = nodesMap[id];
      if (paneItems[id] || !node) return 'idle';
      return node.status === 'streaming' && node.visibleResponseComplete ? 'idle' : node.status ?? 'idle';
    }),
    shallowArrayEqual,
  );
  const kinds = useStructuralSelector(
    (nodesMap) => tabPanes.map((id) => (paneItems[id]?.kind ?? nodesMap[id]?.kind ?? 'chat') as string),
    shallowArrayEqual,
  );
  const temporaries = useStructuralSelector(
    (nodesMap) => tabPanes.map((id) => !paneItems[id] && nodesMap[id]?.temporary === true),
    shallowArrayEqual,
  );

  const { closeOtherPanes, canCloseOtherPanes } = useCloseOtherPanes();

  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const tabRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Keep the active tab in view when it changes (Ctrl+Tab, background opens).
  useEffect(() => {
    if (focusedPane) tabRefs.current[focusedPane]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusedPane]);

  // One Tab stop: the active tab (ST-20). ← and → select the tab beside the
  // focused one and keep the focus on the strip; Home and End go to the ends.
  const tabStop = focusedPane && tabPanes.includes(focusedPane) ? focusedPane : tabPanes[0];
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, id: string) => {
    // Keys on its ⋯ or × are theirs.
    if (event.target !== event.currentTarget) return;
    const next = tabStripKeyTarget(event, tabPanes.indexOf(id), tabPanes.length);
    if (next === null) return;
    event.preventDefault();
    focusPane(tabPanes[next]);
    tabRefs.current[tabPanes[next]]?.focus();
  };

  return (
    <>
    <div
      role="tablist"
      aria-label="Open panes"
      className="hide-sb"
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        marginLeft: leftInset,
        padding: '0 160px 0 8px',
        overflowX: 'auto',
        overflowY: 'hidden',
        // Gaps between tabs stay window-draggable; tabs opt out.
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
    >
      {tabPanes.map((id, i) => (
        <PaneTab
          key={id}
          id={id}
          title={titles[i] || 'Untitled'}
          kind={(kinds[i] ?? 'chat') as TabKind}
          status={statuses[i] ?? 'idle'}
          temporary={temporaries[i] ?? false}
          active={id === focusedPane}
          tabStop={id === tabStop}
          menuOpen={menu?.id === id}
          tabRef={(el) => { tabRefs.current[id] = el; }}
          onKeyDown={(event) => onTabKeyDown(event, id)}
          onSelect={focusPane}
          onClose={closePane}
          onMenu={(x, y, toggle) => setMenu((open) => (toggle && open?.id === id ? null : { id, x, y }))}
          onReorder={reorderPane}
        />
      ))}
      <span style={{ display: 'inline-flex', marginLeft: 4, flexShrink: 0 }}>
        <PaneLauncher />
      </span>
    </div>
      {/* Outside the drag region so Electron doesn't swallow menu clicks. */}
      <AnimatePresence>{menu && (
        <ContextMenu
          key={menuOpenKey(menu)}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          sections={[{
            items: [
              { id: 'close', label: 'Close', keys: kbd('mod', 'W'), run: () => closePane(menu.id) },
              {
                id: 'close-others',
                label: 'Close Others',
                disabled: !canCloseOtherPanes(menu.id),
                run: () => closeOtherPanes(menu.id),
              },
            ],
          }]}
        />
      )}</AnimatePresence>
    </>
  );
}

function PaneTab({ id, title, kind, status, temporary, active, tabStop, menuOpen, tabRef, onKeyDown, onSelect, onClose, onMenu, onReorder }: {
  id: string;
  title: string;
  kind: TabKind;
  status: string;
  temporary: boolean;
  active: boolean;
  /** The strip's one Tab stop. */
  tabStop: boolean;
  menuOpen: boolean;
  tabRef: (el: HTMLDivElement | null) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** `toggle`: from the ⋯, whose second press closes the menu. */
  onMenu: (x: number, y: number, toggle?: boolean) => void;
  onReorder: (fromId: string, toId: string) => void;
}) {
  const [dropTarget, setDropTarget] = useState(false);

  return (
    <div
      ref={tabRef}
      role="tab"
      aria-selected={active}
      tabIndex={tabStop ? 0 : -1}
      title={title}
      // Its look by state, hover included, and the × it reveals are CSS
      // (index.css .pane-tab): moving over the strip renders nothing.
      className="pane-tab t-reveal-host"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData(TAB_DRAG_MIME, id);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
        e.preventDefault();
        setDropTarget(true);
      }}
      onDragLeave={() => setDropTarget(false)}
      onDrop={(e) => {
        setDropTarget(false);
        const from = e.dataTransfer.getData(TAB_DRAG_MIME);
        if (from) onReorder(from, id);
      }}
      onClick={() => onSelect(id)}
      onKeyDown={onKeyDown}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(id); } }}
      onContextMenu={(e) => { e.preventDefault(); onMenu(e.clientX, e.clientY); }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 30,
        flex: '0 1 auto',
        minWidth: 72,
        maxWidth: 240,
        boxSizing: 'border-box',
        padding: '0 6px 0 10px',
        borderRadius: 'var(--ui-radius-lg)',
        boxShadow: dropTarget ? 'inset 2px 0 0 var(--term-accent)' : undefined,
        fontFamily: 'var(--ui-font)',
        fontSize: 'var(--fs-md)',
        userSelect: 'none',
        cursor: 'pointer',
        WebkitAppRegion: 'no-drag',
      } as React.CSSProperties}
    >
      <TabIcon kind={kind} status={status} temporary={temporary} />
      {temporary && <TemporaryChatGlyph size={14} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {title}
      </span>
      {active ? (
        <TabButton
          label={`Actions for ${title}`}
          hasPopup="menu"
          expanded={menuOpen}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onMenu(rect.left, rect.bottom + 4, true);
          }}
        >
          <MoreIcon />
        </TabButton>
      ) : (
        <TabButton label={`Close ${title}`} reveal onClick={() => onClose(id)}>
          <CloseIcon />
        </TabButton>
      )}
    </div>
  );
}

/** A tab's ⋯ or ×; `reveal` shows it only while its tab is hovered or focused (.t-reveal). */
function TabButton({ label, reveal = false, hasPopup, expanded = false, onClick, children }: {
  label: string;
  reveal?: boolean;
  /** A menu trigger, which stays pressed while its menu is open. */
  hasPopup?: 'menu';
  expanded?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={reveal ? 'pane-tab__btn t-reveal' : 'pane-tab__btn'}
      aria-haspopup={hasPopup}
      aria-expanded={hasPopup ? expanded : undefined}
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        width: 22,
        height: 22,
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        border: 'none',
        borderRadius: 'var(--ui-radius-sm)',
        fontFamily: 'inherit',
        fontSize: 'var(--fs-lg)',
        lineHeight: 1,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
