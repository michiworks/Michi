import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Diff, FolderOpen, SquareTerminal } from 'lucide-react';
import type { TerminalListResponse, TerminalSummary } from 'michi-shared';
import { usePaneShellStyle } from '../../hooks/usePaneShellStyle';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { kbd } from '../../lib/platform';
import type { LauncherPaneItem, PaneLauncherChoice, TerminalPaneItem } from '../../state/paneItems';
import type { ChatNodeState, Project } from '../../state/chatTypes';
import { useChatActions, useChatPanes, useOptionalChatProjects, useStructuralSelector } from '../../state/chatStore';
import { nodeDisplayTitle, threadDisplayTitle } from '../../state/displayTitle';
import { terminalTargetForWorkspace } from '../../state/terminalTarget';
import { buildTree, type TreeNode } from '../../state/tree';
import { listTerminals } from '../../services/api/terminals';
import { BranchIcon, ChatIcon } from './icons';

// One line-icon set at one size and stroke (the topbar's).
const ICON = { size: 16, strokeWidth: 1.6, absoluteStrokeWidth: true, 'aria-hidden': true } as const;

const CHOICES: Array<{
  id: PaneLauncherChoice;
  icon: React.ReactNode;
  label: string;
  description: string;
}> = [
  { id: 'review', icon: <Diff {...ICON} />, label: 'Review', description: 'Inspect workspace changes' },
  { id: 'terminal', icon: <SquareTerminal {...ICON} />, label: 'Terminal', description: 'Start in this workspace' },
  { id: 'files', icon: <FolderOpen {...ICON} />, label: 'Files', description: 'Browse workspace and artifacts' },
  // The name the shortcut list gives it (Settings › Keyboard shortcuts), and its keys.
  { id: 'side-chat', icon: <BranchIcon size={16} strokePx={1.6} />, label: 'Blank branch', description: `Branch off this thread, empty · ${kbd('mod', 'alt', 'T')}` },
];

/** How long after closing the pane that takes over may still focus its composer on its own. */
const COMPOSER_FOCUS_WINDOW_MS = 400;

/**
 * Esc gives focus back to the + that opened the chooser. The pane that takes
 * over focuses its composer once it shows (TPane), some frames later, and
 * that one focus is sent back to the +.
 */
function returnFocusToPlus(): void {
  const plus = document.querySelector<HTMLButtonElement>('button[aria-label="New pane"]');
  if (!plus) return;
  plus.focus();
  const keep = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement) || !event.target.isContentEditable) return;
    stop();
    plus.focus();
  };
  const stop = () => { clearTimeout(timer); document.removeEventListener('focusin', keep, true); };
  const timer = setTimeout(stop, COMPOSER_FOCUS_WINDOW_MS);
  document.addEventListener('focusin', keep, true);
}

/** Rows the arrow keys move through, in the order they show. */
const ROW_SELECTOR = 'button[data-chooser-row]:not(:disabled)';

/** A thread's conversations that no pane shows, listed above the choices. */
const MAX_UNOPENED = 5;
type Unopened = { shown: Array<{ id: string; title: string }>; more: number };
const NO_UNOPENED: Unopened = { shown: [], more: 0 };
const sameUnopened = (a: Unopened, b: Unopened) => a.more === b.more && a.shown.length === b.shown.length
  && a.shown.every((row, i) => row.id === b.shown[i].id && row.title === b.shown[i].title);

function treeOrder(node: TreeNode, out: string[] = []): string[] {
  out.push(node.nodeId);
  for (const child of node.children) treeOrder(child, out);
  return out;
}

function unopenedInThread(nodes: Record<string, ChatNodeState>, project: Project | undefined, treeId: string | null, open: ReadonlySet<string>): Unopened {
  const tree = treeId ? project?.trees.find((candidate) => candidate.id === treeId) : undefined;
  if (!project || !tree) return NO_UNOPENED;
  const alive = (id: string) => !!nodes[id] && !nodes[id].deletedAt;
  if (!alive(tree.rootNodeId)) return NO_UNOPENED;
  const ids = treeOrder(buildTree(tree.rootNodeId, project.edges, alive))
    .filter((id) => nodes[id].kind === 'chat' && !open.has(id));
  return {
    shown: ids.slice(0, MAX_UNOPENED).map((id) => ({
      id,
      title: id === tree.rootNodeId ? threadDisplayTitle(tree, nodes[id], 'Untitled') : nodeDisplayTitle(nodes[id], 'Untitled'),
    })),
    more: Math.max(0, ids.length - MAX_UNOPENED),
  };
}

const SECTION_STYLE: React.CSSProperties = { fontSize: 'var(--fs-2xs)', color: 'var(--term-muted)', padding: '0 10px', marginBottom: 2, fontFamily: 'var(--ui-font)', letterSpacing: 'var(--ls-wide)', textTransform: 'uppercase' };
const RULE_STYLE: React.CSSProperties = { borderBottom: '1px solid var(--term-line)', margin: '4px 0' };
const KEY_STYLE: React.CSSProperties = { minWidth: 18, height: 18, padding: '0 4px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--term-line-s)', borderRadius: 3, color: 'var(--term-mid)', fontFamily: 'var(--ui-font)', fontSize: 'var(--fs-xs)' };
const HINTS: Array<[keys: string, label: string]> = [['↑↓', 'move'], ['↵', 'open'], ['1–4', 'pick'], ['esc', 'close']];

const buttonStyle: React.CSSProperties = {
  minHeight: 52,
  display: 'grid',
  gridTemplateColumns: '30px minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: 10,
  padding: '7px 10px',
  borderRadius: 'var(--ui-radius)',
  color: 'var(--term-fg)',
  cursor: 'pointer',
  fontFamily: 'var(--ui-font)',
  textAlign: 'left' as const,
  transition: 'background var(--t-quick) var(--t-ease), border-color var(--t-quick) var(--t-ease), opacity var(--t-quick) var(--t-ease)',
};

/** The choice that is opening keeps the frame its hover had. */
const CHOSEN: React.CSSProperties = { background: 'var(--term-alt)', borderColor: 'var(--term-line)' };

/** Truncate a cwd path to something legible inside the chooser. */
function shortCwd(cwd: string): string {
  if (!cwd) return '~';
  // Show last 2 path segments at most.
  const parts = cwd.replace(/\/$/, '').split('/');
  if (parts.length <= 3) return cwd.startsWith('/') ? cwd : `~/${cwd}`;
  return `…/${parts.slice(-2).join('/')}`;
}

function sharedNote(terminal: TerminalSummary, phone: boolean): string {
  if (terminal.exited) return 'exited';
  if (phone && terminal.clients.desktop > 0) return 'also on desktop';
  if (!phone && terminal.clients.phone > 0) return 'also on phone';
  if (terminal.clients.desktop + terminal.clients.phone > 0) return 'open elsewhere';
  const idleMinutes = Math.floor((Date.now() - terminal.lastActiveAt) / 60_000);
  return idleMinutes >= 60 ? `idle ${Math.floor(idleMinutes / 60)}h` : idleMinutes >= 1 ? `idle ${idleMinutes}m` : 'running';
}

/** The backend terminals this workspace can use, when it uses them (state/terminalTarget.ts). */
function useBackendTerminals(connectionId: string | null): TerminalListResponse | null {
  const [list, setList] = useState<TerminalListResponse | null>(null);
  useEffect(() => {
    setList(null);
    if (connectionId === null) return;
    const controller = new AbortController();
    listTerminals(connectionId, controller.signal).then(setList, (error: unknown) => {
      if (!controller.signal.aborted) setList({ available: false, reason: 'unsupported', message: error instanceof Error ? error.message : 'Terminals are unavailable.', terminals: [] });
    });
    return () => controller.abort();
  }, [connectionId]);
  return list;
}

export default function PaneChooser({ item }: { item: LauncherPaneItem }) {
  const { activateLauncherPane, adoptTerminalPane, adoptBackendTerminal, openNodeInLauncherPane, focusPane, closePane } = useChatActions();
  const { paneItems, openPanes, focusedPane } = useChatPanes();
  const workspace = useOptionalChatProjects()?.projects.find((project) => project.id === item.projectId);
  const rootRef = useRef<HTMLDivElement>(null);
  const openSet = useMemo(() => new Set(openPanes), [openPanes]);
  const selectUnopened = useCallback(
    (nodes: Record<string, ChatNodeState>) => unopenedInThread(nodes, workspace, item.treeId, openSet),
    [workspace, item.treeId, openSet],
  );
  const unopened = useStructuralSelector(selectUnopened, sameUnopened);
  const shellStyle = usePaneShellStyle(item.id);
  const phone = usePhoneLayout();
  const [pending, setPending] = useState<PaneLauncherChoice | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [terminalNote, setTerminalNote] = useState(false);
  const target = terminalTargetForWorkspace(workspace);
  const backendConnectionId = target.transport === 'backend' ? target.connectionId : null;
  const backendTerminals = useBackendTerminals(backendConnectionId);
  const terminalOff = backendConnectionId !== null && backendTerminals !== null && !backendTerminals.available ? backendTerminals : null;

  const detachedTerminals = useMemo(() => Object.values(paneItems).filter(
    (entry): entry is TerminalPaneItem =>
      entry.kind === 'terminal' && !openSet.has(entry.id),
  ), [paneItems, openSet]);

  // Terminals the backend runs that no pane of this window holds: another
  // window's, or ones whose pane this window lost (a reload of another tab).
  const otherTerminals = useMemo(() => {
    if (!backendTerminals?.available) return [];
    const held = new Set(Object.values(paneItems).flatMap((entry) => entry.kind === 'terminal' ? [entry.surfaceId] : []));
    return backendTerminals.terminals.filter((terminal) => !held.has(terminal.terminalId));
  }, [backendTerminals, paneItems]);

  const choose = async (choice: PaneLauncherChoice) => {
    if (choice === 'terminal' && terminalOff) { setTerminalNote((open) => !open); return; }
    if (pending || adopting) return;
    setPending(choice);
    try {
      await activateLauncherPane(item.id, choice);
    } catch (error) {
      setPending(null);
      toast.error(error instanceof Error ? error.message : 'Unable to open pane');
    }
  };

  const adopt = (terminalId: string) => {
    if (pending || adopting) return;
    setAdopting(terminalId);
    adoptTerminalPane(item.id, terminalId);
  };

  const adoptBackend = (terminal: TerminalSummary) => {
    if (pending || adopting || backendConnectionId === null) return;
    setAdopting(terminal.terminalId);
    adoptBackendTerminal(item.id, terminal, backendConnectionId);
  };

  const openHere = (nodeId: string) => {
    if (pending || adopting) return;
    openNodeInLauncherPane(item.id, nodeId);
  };

  const busy = pending !== null || adopting !== null;
  const runningCount = detachedTerminals.length + otherTerminals.length;

  // The chooser takes the keyboard when its pane does: on opening, or when
  // the pane is focused from elsewhere (⌃Tab). Focus already inside stays.
  // The row the keys act on shows it (data-keys, index.css) from the start,
  // although the click on + that opened the chooser was the pointer's.
  const isFocusedPane = focusedPane === item.id;
  useEffect(() => {
    const root = rootRef.current;
    if (!isFocusedPane || !root || root.contains(document.activeElement)) return;
    const first = root.querySelector<HTMLButtonElement>(ROW_SELECTOR);
    if (!first) return;
    root.toggleAttribute('data-keys', true);
    first.focus({ preventScroll: true });
  }, [isFocusedPane]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || busy) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePane(item.id);
      returnFocusToPlus();
      return;
    }
    const pick = /^[1-4]$/.test(e.key) ? CHOICES[Number(e.key) - 1] : undefined;
    if (pick) {
      e.preventDefault();
      void choose(pick.id);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const rows = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>(ROW_SELECTOR) ?? []);
    if (rows.length === 0) return;
    e.preventDefault();
    rootRef.current?.toggleAttribute('data-keys', true);
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? rows.length - 1
        : e.key === 'ArrowDown' ? Math.min(rows.length - 1, at + 1)
          : at < 0 ? 0 : Math.max(0, at - 1);
    rows[next].focus();
  };

  return (
    <div
      data-pane-id={item.id}
      data-pane-kind="launcher"
      className="terminal-pane"
      onMouseDown={() => focusPane(item.id)}
      style={{ ...shellStyle, justifyContent: 'center' }}
    >
      <div
        ref={rootRef}
        role="group"
        aria-label="Choose pane type"
        className="pane-chooser"
        onKeyDown={onKeyDown}
        onPointerDown={() => rootRef.current?.toggleAttribute('data-keys', false)}
        style={{
          width: 'min(420px, calc(100% - 48px))',
          margin: '0 auto',
          display: 'grid',
          gap: 3,
        }}
      >
        {/* ── This thread's conversations no pane shows ── */}
        {unopened.shown.length > 0 && (
          <>
            <div style={SECTION_STYLE}>In this thread, not open</div>
            {unopened.shown.map((row) => (
              <button
                key={row.id}
                type="button"
                data-chooser-row=""
                disabled={busy}
                onClick={() => openHere(row.id)}
                className="t-hover-frame pane-chooser-row"
                style={{ ...buttonStyle, minHeight: 40, opacity: busy ? 0.45 : 1, cursor: busy ? 'default' : 'pointer' }}
              >
                <span aria-hidden style={{ color: 'var(--term-mid)', display: 'grid', placeItems: 'center' }}><ChatIcon size={16} /></span>
                <span style={{ minWidth: 0, fontSize: 'var(--fs-lg)', fontWeight: 500, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.title}</span>
              </button>
            ))}
            {unopened.more > 0 ? (
              <div style={{ padding: '2px 10px 0 50px', color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', fontFamily: 'var(--ui-font)' }}>
                {unopened.more} more in the sidebar
              </div>
            ) : null}
            <div style={RULE_STYLE} />
          </>
        )}

        {/* ── Detached terminal section ── */}
        {runningCount > 0 && (
          <>
            <div style={SECTION_STYLE}>
              Running terminals
            </div>
            {detachedTerminals.map((term) => {
              const isAdopting = adopting === term.id;
              return (
                <button
                  key={term.id}
                  type="button"
                  disabled={busy}
                  aria-label={`Resume terminal — ${term.cwd || '~'}`}
                  onClick={() => adopt(term.id)}
                  data-chooser-row=""
                  className="t-hover-frame pane-chooser-row"
                  style={{
                    ...buttonStyle,
                    ...(isAdopting ? CHOSEN : undefined),
                    opacity: busy && !isAdopting ? 0.45 : 1,
                    cursor: busy ? 'default' : 'pointer',
                  }}
                >
                  <span aria-hidden style={{ color: 'var(--term-digest)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', textAlign: 'center' }}>
                    {isAdopting ? '…' : '●'}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 'var(--fs-lg)', fontWeight: 500, lineHeight: 1.3 }}>Terminal</span>
                    <span style={{ display: 'block', marginTop: 2, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shortCwd(term.cwd)}
                    </span>
                  </span>
                </button>
              );
            })}
            {otherTerminals.map((terminal) => {
              const isAdopting = adopting === terminal.terminalId;
              return (
                <button
                  key={terminal.terminalId}
                  type="button"
                  disabled={busy}
                  aria-label={`Open terminal — ${terminal.cwd || '~'}`}
                  onClick={() => adoptBackend(terminal)}
                  data-chooser-row=""
                  className="t-hover-frame pane-chooser-row"
                  style={{
                    ...buttonStyle,
                    ...(isAdopting ? CHOSEN : undefined),
                    opacity: busy && !isAdopting ? 0.45 : 1,
                    cursor: busy ? 'default' : 'pointer',
                  }}
                >
                  <span aria-hidden style={{ color: terminal.exited ? 'var(--term-muted)' : 'var(--term-digest)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)', textAlign: 'center' }}>
                    {isAdopting ? '…' : '●'}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 'var(--fs-lg)', fontWeight: 500, lineHeight: 1.3 }}>Terminal</span>
                    <span style={{ display: 'block', marginTop: 2, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shortCwd(terminal.cwd)} · {sharedNote(terminal, phone)}
                    </span>
                  </span>
                </button>
              );
            })}
            <div style={RULE_STYLE} />
          </>
        )}

        {/* ── Standard choices ── */}
        {CHOICES.map((choice, index) => {
          const isPending = pending === choice.id;
          // A phone with Terminal off, or a backend without terminals: say why instead of opening a pane that cannot start.
          const off = choice.id === 'terminal' && terminalOff !== null;
          const description = off ? (terminalOff.reason === 'phone-off' ? 'Off on this phone' : 'Unavailable on this machine') : choice.description;
          return (
            <React.Fragment key={choice.id}>
            <button
              type="button"
              data-chooser-row=""
              disabled={busy}
              aria-label={choice.label}
              aria-keyshortcuts={phone ? undefined : String(index + 1)}
              aria-expanded={off ? terminalNote : undefined}
              onClick={() => { void choose(choice.id); }}
              className="t-hover-frame pane-chooser-row"
              style={{
                ...buttonStyle,
                ...(isPending ? CHOSEN : undefined),
                opacity: busy && !isPending ? 0.45 : 1,
                cursor: busy ? 'default' : 'pointer',
              }}
            >
              <span aria-hidden style={{ color: 'var(--term-mid)', display: 'grid', placeItems: 'center', opacity: off ? 0.45 : 1 }}>
                {isPending ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)' }}>…</span> : choice.icon}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-lg)', fontWeight: 500, lineHeight: 1.3, opacity: off ? 0.45 : 1 }}>{choice.label}</span>
                <span style={{ display: 'block', marginTop: 2, color: 'var(--term-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{description}</span>
              </span>
              {off ? (
                <span style={{ color: 'var(--term-muted)', border: '1px solid var(--term-line)', borderRadius: 'var(--ui-radius-pill)', padding: '1px 7px', fontSize: 'var(--fs-xs)', whiteSpace: 'nowrap' }}>Off</span>
              ) : phone ? null : (
                <kbd aria-hidden style={KEY_STYLE}>{index + 1}</kbd>
              )}
            </button>
            {off && terminalNote ? (
              <div role="note" style={{ margin: '2px 10px 4px 50px', padding: '8px 10px', borderLeft: '2px solid var(--term-line-s)', color: 'var(--term-mid)', fontSize: 'var(--fs-sm)', lineHeight: 1.5, fontFamily: 'var(--ui-font)' }}>
                {terminalOff.reason === 'phone-off'
                  ? <>Terminals run on the machine Michi runs on, with your account, so phones can&apos;t open them unless you allow it. Turn on <strong>Settings › Phone access › Terminal</strong> on your computer.</>
                  : terminalOff.message}
              </div>
            ) : null}
            </React.Fragment>
          );
        })}
        {phone ? null : (
          <div aria-hidden style={{ display: 'flex', gap: 14, padding: '10px 10px 0', color: 'var(--term-muted)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--ui-font)' }}>
            {HINTS.map(([keys, label]) => (
              <span key={label}><kbd style={{ color: 'var(--term-mid)', fontFamily: 'inherit', marginRight: 4 }}>{keys}</kbd>{label}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
