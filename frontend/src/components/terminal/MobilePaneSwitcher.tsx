import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'motion/react';
import { activeTreeRootNodeId, shallowArrayEqual, useChatActions, useChatPanes, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { buildTree, type TreeNode } from '../../state/tree';
import { paneTitle } from '../../state/paneLabels';
import { useCloseOtherPanes } from '../../state/closeOtherPanes';
import { DUR, EASE } from '../../motion/tokens';
import ContextMenu, { MenuPresence, menuOpenKey } from '../ContextMenu';
import { PopoverSurface } from '../ui/Popover';
import { branchMotionAllowed, branchMotionReduced, isFreshBranch, playBranchFlight, pulseBranchTarget, type BranchFlightOrigin } from './branchMotion';
import { BranchIcon } from './icons';
import { TemporaryChatGlyph } from './TemporaryChat';
import './mobile.css';

/** A tap this recent is the gesture that started the branch. */
const FLIGHT_TAP_MS = 2000;
/** The list lifts back toward its trigger as it fades (PopoverSurface keeps the
 *  ghost inert and roleless while it leaves). */
const LIST_EXIT = { opacity: 0, y: -4, transition: { duration: DUR.exit, ease: EASE.out } };

/** The accepted Touch study: a right-hand list of indented titles, not cards.
 * Branches in the current tree can reopen a closed pane, and open panes carry
 * a close button: phones have no tab strip or caption cells to close from.
 * Non-chat panes remain reachable below the tree, and merge/link edges never
 * pull in another tree. */
export function MobilePaneSwitcher() {
  const { activeProject } = useChatProjects();
  const { openPanes, tabPanes, focusedPane, paneItems = {} } = useChatPanes();
  const { openPane, focusPane, closePane } = useChatActions();
  const { closeOtherPanes, canCloseOtherPanes } = useCloseOtherPanes();
  const [open, setOpen] = useState(false);
  // An open pane's own menu (a long press on its row): what a tab's menu offers.
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const panes = tabPanes ?? openPanes;
  const aliveIds = useStructuralSelector(nodes => Object.keys(nodes).filter(key => nodes[key].projectId === activeProject?.id && !nodes[key].deletedAt), shallowArrayEqual);
  const rows = useMemo(() => {
    const root = activeProject && activeTreeRootNodeId(activeProject);
    const alive = new Set(aliveIds);
    const result: { id: string; depth: number }[] = [];
    const add = (node: TreeNode) => { result.push({ id: node.nodeId, depth: node.depth }); node.children.forEach(add); };
    if (root && alive.has(root)) add(buildTree(root, activeProject!.edges, key => alive.has(key)));
    for (const paneId of panes) if (paneItems[paneId]?.kind !== 'browser' && !result.some(row => row.id === paneId)) result.push({ id: paneId, depth: 0 });
    return result;
  }, [activeProject, aliveIds, panes, paneItems]);
  const titles = useStructuralSelector(nodes => rows.map(row => paneTitle(nodes[row.id], paneItems[row.id]) || 'Untitled'), shallowArrayEqual);
  const statuses = useStructuralSelector(nodes => rows.map(row => nodes[row.id]?.status === 'streaming' && !nodes[row.id]?.visibleResponseComplete ? 'streaming' : nodes[row.id]?.status === 'error' ? 'error' : 'idle'), shallowArrayEqual);
  const temporaries = useStructuralSelector(nodes => rows.map(row => !paneItems[row.id] && nodes[row.id]?.temporary === true), shallowArrayEqual);
  const dismiss = (restore = true) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useEffect(() => { setOpen(false); }, [activeProject?.id, activeProject?.activeTreeId]);
  useEffect(() => { if (!open) setRowMenu(null); }, [open]);

  // A branch started in the background changes nothing on screen, so show it
  // leaving the tap for the switcher. Foreground branches push in (Dashboard).
  const [flight, setFlight] = useState<{ id: string; from: BranchFlightOrigin } | null>(null);
  const chip = useRef<HTMLSpanElement>(null);
  const lastTap = useRef<BranchFlightOrigin & { at: number } | null>(null);
  useEffect(() => {
    const remember = (event: PointerEvent) => { lastTap.current = { x: event.clientX, y: event.clientY, at: performance.now() }; };
    document.addEventListener('pointerdown', remember, true);
    return () => document.removeEventListener('pointerdown', remember, true);
  }, []);
  const knownRows = useRef({ tree: activeProject?.activeTreeId, ids: new Set(rows.map(row => row.id)) });
  useLayoutEffect(() => {
    const previous = knownRows.current;
    knownRows.current = { tree: activeProject?.activeTreeId, ids: new Set(rows.map(row => row.id)) };
    if (previous.tree !== activeProject?.activeTreeId) return;
    const arrived = rows.find(row => !previous.ids.has(row.id) && row.id !== focusedPane && isFreshBranch(activeProject?.edges, row.id));
    if (!arrived || !branchMotionAllowed()) return;
    if (branchMotionReduced()) {
      if (trigger.current) pulseBranchTarget(trigger.current);
      return;
    }
    const tap = lastTap.current;
    const from = tap && performance.now() - tap.at < FLIGHT_TAP_MS ? tap : { x: window.innerWidth / 2, y: window.innerHeight - 72 };
    setFlight({ id: arrived.id, from: { x: from.x, y: from.y } });
  }, [rows, focusedPane, activeProject?.activeTreeId, activeProject?.edges]);
  useLayoutEffect(() => {
    if (!flight || !chip.current || !trigger.current) return;
    return playBranchFlight(chip.current, trigger.current, flight.from, () => setFlight(null));
  }, [flight]);

  useEffect(() => {
    if (!open) return;
    (panel.current?.querySelector<HTMLButtonElement>('.mobile-pane-row[aria-current="page"]') ?? panel.current?.querySelector<HTMLButtonElement>('.mobile-pane-row'))?.focus({ preventScroll: true });
    const pointer = (event: PointerEvent) => {
      // A row's own menu is part of the list.
      if ((event.target as Element | null)?.closest?.('[data-phone-menu]')) return;
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('.mobile-pane-row') ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault(); buttons[next]?.focus();
      }
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', pointer, true); document.removeEventListener('keydown', key, true); };
  }, [open]);
  if (rows.length < 2) return null;
  // A pane it holds, other than the one on screen, is working: the icon's
  // short middle line breathes in the accent, so a branch started here leaves
  // a trace after its ring. Not a corner dot: on a phone that reads as unread.
  const working = rows.some((row, index) => row.id !== focusedPane && statuses[index] === 'streaming');
  // One parent line over two indented children: an outline of the tree, so it
  // doesn't read as the hamburger that opens a drawer. Sized by mobile.css.
  return <>
    <button ref={trigger} type="button" className="mobile-pane-trigger t-icon-btn" aria-label="Switch pane" aria-expanded={open} aria-controls={id} data-working={working ? 'true' : undefined}
      onClick={() => setOpen(value => !value)}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M10 18h10" /><path className="mobile-pane-trigger__live" d="M10 12h10" /></svg></button>
    <AnimatePresence>{open && <PopoverSurface key="list" ref={panel} role="navigation" aria-label="Branches and panes" right={12} top={52}
      width="min(300px, calc(100vw - 24px))" maxHeight="calc(100dvh - 76px)" className="mobile-pane-list" glass exit={LIST_EXIT}>
      <div id={id} onBlur={event => {
        const next = event.relatedTarget as Element | null;
        if (next && !event.currentTarget.contains(next) && !next.closest('[data-phone-menu]')) setOpen(false);
      }}>{rows.map((row, index) => {
        const isOpen = panes.includes(row.id);
        return <div key={row.id} className="mobile-pane-item" data-current={focusedPane === row.id ? '' : undefined}
          data-context-target={isOpen ? '' : undefined}
          onContextMenu={event => {
            event.preventDefault();
            if (isOpen) setRowMenu({ id: row.id, x: event.clientX, y: event.clientY });
          }}>
          <button type="button" className="mobile-pane-row"
            style={{ '--pane-depth': Math.min(row.depth, 10) } as React.CSSProperties}
            aria-current={focusedPane === row.id ? 'page' : undefined}
            onClick={() => { if (isOpen) focusPane(row.id); else openPane(row.id); dismiss(); }}>
            <span>{temporaries[index] && <TemporaryChatGlyph size={15} inline />}{titles[index]}</span>
            {statuses[index] !== 'idle' && <i className="mobile-pane-status" data-status={statuses[index]} aria-label={statuses[index] === 'streaming' ? 'Working' : 'Error'} />}
          </button>
          {/* The list stays open so several panes can be closed in a row; a
              tree branch stays listed and can be reopened. */}
          {isOpen && <button type="button" className="mobile-pane-close" aria-label={`Close ${titles[index]}`}
            onClick={event => { (event.currentTarget.previousElementSibling as HTMLButtonElement | null)?.focus({ preventScroll: true }); closePane(row.id); }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>}
        </div>;
      })}</div>
    </PopoverSurface>}</AnimatePresence>
    <MenuPresence>{rowMenu && <ContextMenu key={menuOpenKey(rowMenu)} x={rowMenu.x} y={rowMenu.y} onClose={() => setRowMenu(null)} sections={[{
      items: [
        { id: 'close', label: 'Close', run: () => closePane(rowMenu.id) },
        {
          id: 'close-others',
          label: 'Close Others',
          disabled: !canCloseOtherPanes(rowMenu.id),
          run: () => closeOtherPanes(rowMenu.id),
        },
      ],
    }]} />}</MenuPresence>
    {flight && createPortal(<span ref={chip} key={flight.id} className="mobile-branch-flight" aria-hidden="true"><BranchIcon size={16} /></span>, document.body)}
  </>;
}
