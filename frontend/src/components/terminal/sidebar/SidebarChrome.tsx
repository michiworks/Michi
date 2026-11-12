import React, { useCallback, useId } from 'react';
import { Plus, Search } from 'lucide-react';
import { useChatProjects, useStructuralSelector } from '../../../state/chatStore';
import type { ChatNodeState } from '../../../state/chatTypes';
import { usePrefs } from '../../../state/prefs';
import { selectUnreadTotal } from '../../../state/sidebarSelectors';
import { useVisibleRemoteRecoveryIssues, type RemoteRecoveryIssue } from '../../../state/remoteRecovery';
import { kbd } from '../../../lib/platform';
import { Button } from '../../ui/controls';
import { HoverTip } from '../../ui/Popover';
import { OPEN_SETTINGS_SECTION_EVENT } from '../scheduled/metaAgent/metaAgentNav';

/** The narrow drawer's first row: New chat (opens Home, ⌘T) and Search (the
 *  ⌘K palette). A wide window keeps both in the Topbar. */
export function SidebarNewChatRow({ onNewChat, onOpenPalette, searchDisabled = false }: {
  onNewChat?: () => void;
  onOpenPalette?: () => void;
  /** The palette needs workspaces; it waits for hydration. */
  searchDisabled?: boolean;
}) {
  if (!onNewChat && !onOpenPalette) return null;
  return (
    <div className="sidebar-new-row">
      {onNewChat && (
        <Button className="sidebar-new-row__new" onClick={onNewChat}>
          <Plus size={15} strokeWidth={1.5} aria-hidden="true" />
          <span className="sidebar-new-row__label">New chat</span>
          <kbd className="sidebar-new-row__kbd" aria-hidden="true">{kbd('mod', 'T')}</kbd>
        </Button>
      )}
      {onOpenPalette && (
        <HoverTip label="Search" kbd={kbd('mod', 'K')} disabled={searchDisabled}>
          <Button className="sidebar-new-row__search" aria-label="Search" disabled={searchDisabled} onClick={onOpenPalette}>
            <Search size={15} strokeWidth={1.5} aria-hidden="true" />
          </Button>
        </HoverTip>
      )}
    </div>
  );
}

const VIEWS = [
  { view: 'structure', label: 'By project' },
  { view: 'activity', label: 'Recent' },
] as const;

/** The panel the view tabs control; its id comes from SidebarViewTabs. */
export function SidebarViewPanel({ tabsId, children }: { tabsId: string; children: React.ReactNode }) {
  const { prefs } = usePrefs();
  return (
    <div className="sidebar-view-panel" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${prefs.sidebarView}`}>
      {children}
    </div>
  );
}

/**
 * By project / Recent: the sidebar's two views (the `sidebarView` pref, also
 * ⌥⌘U). Recent carries the unread count, so a finished reply is findable
 * from either view. It counts only what Recent lists (selectUnreadTotal).
 */
export function SidebarViewTabs({ id }: { id: string }) {
  const { prefs, setPref } = usePrefs();
  const { projects, focusedNodeId } = useChatProjects();
  const unreadSelector = useCallback(
    (nodes: Record<string, ChatNodeState>) => selectUnreadTotal(projects, nodes, focusedNodeId),
    [projects, focusedNodeId],
  );
  const unread = useStructuralSelector(unreadSelector);
  const select = (view: (typeof VIEWS)[number]['view'], focus = false) => {
    if (prefs.sidebarView !== view) setPref('sidebarView', view);
    if (focus) document.getElementById(`${id}-${view}`)?.focus();
  };
  return (
    <div className="sidebar-view-tabs" role="tablist" aria-label="Sidebar view">
      {VIEWS.map(({ view, label }, index) => {
        const selected = prefs.sidebarView === view;
        const count = view === 'activity' && unread > 0 ? unread : 0;
        return (
          <button
            key={view}
            id={`${id}-${view}`}
            type="button"
            role="tab"
            className="sidebar-view-tabs__tab"
            aria-label={count ? `${label}, ${count} unread` : undefined}
            aria-selected={selected}
            aria-controls={`${id}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => select(view)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
              event.preventDefault();
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? VIEWS.length - 1
                : (index + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length;
              select(VIEWS[next].view, true);
            }}
          >
            {label}
            {count > 0 && <span className="sidebar-view-tabs__count" aria-hidden="true">{count > 9 ? '9+' : count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** A stable id for one sidebar's tabs and the panel they control. */
export function useSidebarViewTabsId(): string {
  return `sidebar-view-${useId().replace(/[^\w-]/g, '')}`;
}

function offlineLabel(issues: readonly RemoteRecoveryIssue[]): string {
  return issues.length === 1 ? `${issues[0].name} offline` : `${issues.length} machines offline`;
}

/** Opens Settings on the Machines page (TerminalShell listens). */
function openMachinesSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { section: 'machines' } }));
}

/**
 * The sidebar foot: a remote machine that went offline or failed to connect,
 * once it has stayed that way past the recovery grace period (the same issues
 * the topbar's recovery button reports). Nothing while every machine is fine.
 */
export function SidebarConnectionChip() {
  const issues = useVisibleRemoteRecoveryIssues();
  if (issues.length === 0) return null;
  const label = offlineLabel(issues);
  return (
    <div className="sidebar-foot">
      <button
        type="button"
        className="sidebar-conn-chip"
        aria-label={`${label}, open Machines settings`}
        aria-haspopup="dialog"
        title={issues.map((issue) => issue.diagnostic.message || issue.name).join('\n')}
        onClick={openMachinesSettings}
      >
        <span className="sidebar-conn-chip__dot" aria-hidden="true" />
        <span className="sidebar-conn-chip__label">{label}</span>
      </button>
    </div>
  );
}
