import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { CirclePause, X } from 'lucide-react';
import { toast } from 'sonner';
import { useChatActions, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import {
  backendConnectionIdForWorkspace,
  LOCAL_BACKEND_CONNECTION_ID,
  subscribeBackendConnections,
} from '../../config/backendConnections';
import { relativeTime } from '../../lib/relativeTime';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import {
  dismissInterruptedTurn,
  fetchInterruptedTurns,
  type InterruptedTurn,
} from '../../services/api/interruptedTurns';
import {
  interruptedTurnKey,
  interruptedTurnState,
  selectTurnOutcomes,
  turnOutcomesEqual,
} from './interruptedTurnsModel';
import { Button } from '../ui/controls';
import { NoticeHeader, NoticeMotion, NoticeTab, shrinkOnEscape, useAnnounceNew, useNoticeMinimized } from './shellNoticeParts';

/** What Resume does, on hover: the notice keeps its words to the actions. */
const RESUME_HINT = 'Carries the task on from its saved output; does not send the request again';
/** Rows the notice lists before "All N". */
const COLLAPSED_ROWS = 3;
/** Turn outcomes often change in bursts (a restart ends many at once). */
const REFRESH_DEBOUNCE_MS = 600;
/** How long Resume waits for the chat it opened to load its interrupted turn. */
const RESUME_WAIT_MS = 10_000;

/**
 * Global reminder of tasks that stopped before finishing because Michi
 * restarted (an update, a crash) or the agent's credentials expired (a lapsed
 * Auth session). It lists them across every workspace and backend, and
 * Resume carries a task on from its kept partial output (the same
 * continuation the chat's own Resume sends); it never re-sends the request.
 *
 * The backend decides what is interrupted (GET /interrupted-turns). An entry
 * leaves once its conversation moves on, Resume or any new message, or when
 * it is dismissed. Lives in the shell's notice corner (ShellNotices), under
 * the Ask User notice; it can shrink to a tab, and a new interruption opens
 * it again. On a phone it starts as the tab.
 */
export default function InterruptedTurnsNotice() {
  const { projects } = useChatProjects();
  const { revealNode, resumeLastTurn } = useChatActions();
  const outcomes = useStructuralSelector(selectTurnOutcomes, turnOutcomesEqual);
  const [items, setItems] = useState<InterruptedTurn[]>([]);
  /** Resumed or dismissed here, kept out until the backend's list catches up. */
  const [settled, setSettled] = useState<ReadonlySet<string>>(() => new Set());
  /** A Resume waiting for the chat it opened to load the interrupted turn. */
  const [pendingResume, setPendingResume] = useState<InterruptedTurn | null>(null);
  const [showAll, setShowAll] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const connectionKey = useMemo(() => {
    const ids = new Set<string>([LOCAL_BACKEND_CONNECTION_ID]);
    for (const project of projects) ids.add(project.backendConnectionId ?? backendConnectionIdForWorkspace(project.id));
    return [...ids].sort().join('\n');
  }, [projects]);

  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const run = ++generation.current;
    const results = await Promise.allSettled(connectionKey.split('\n').map((id) => fetchInterruptedTurns(id)));
    if (!mounted.current || run !== generation.current) return;
    // A backend that cannot be reached keeps the entries it listed before.
    setItems((previous) => {
      const next: InterruptedTurn[] = [];
      connectionKey.split('\n').forEach((id, index) => {
        const result = results[index];
        if (result.status === 'fulfilled') next.push(...result.value);
        else next.push(...previous.filter((item) => item.backendConnectionId === id));
      });
      return next.sort((a, b) => b.interruptedAt - a.interruptedAt);
    });
  }, [connectionKey]);

  // Debounced: on mount, when a turn starts, ends or fails anywhere, when the backends change.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void refresh(); }, REFRESH_DEBOUNCE_MS);
  }, [refresh]);
  useEffect(() => {
    scheduleRefresh();
  }, [scheduleRefresh, outcomes]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') scheduleRefresh(); };
    window.addEventListener('focus', scheduleRefresh);
    document.addEventListener('visibilitychange', onVisible);
    const unsubscribe = subscribeBackendConnections(scheduleRefresh);
    return () => {
      window.removeEventListener('focus', scheduleRefresh);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [scheduleRefresh]);

  // A listed chat that runs again (or failed again since) leaves at once.
  const visible = items.filter((item) => !settled.has(interruptedTurnKey(item))
    && interruptedTurnState(outcomes[item.nodeId], item.turnId) !== 'moved-on');
  useEffect(() => { if (visible.length <= COLLAPSED_ROWS) setShowAll(false); }, [visible.length]);
  const keys = useMemo(() => visible.map(interruptedTurnKey), [visible]);
  // A phone has no room beside the content: there the notice starts as its tab.
  const phone = usePhoneLayout();
  const { minimized, minimize, expand, focus, focusDone } = useNoticeMinimized(keys, { storageKey: 'interrupted', startShrunk: phone });
  useAnnounceNew(keys, () => `Interrupted: ${keys.length} ${keys.length === 1 ? 'task' : 'tasks'}`);
  /** The row the keyboard moves to once the one it was on leaves the list. */
  const [focusRow, setFocusRow] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!focusRow) return;
    const row = [...(list.current?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [])].find((el) => el.dataset.rowKey === focusRow);
    row?.querySelector<HTMLElement>('.interrupted-notice-resume')?.focus();
    setFocusRow(null);
  }, [focusRow, keys]);

  const settle = useCallback((key: string, on: boolean) => {
    setSettled((previous) => {
      const next = new Set(previous);
      if (on) next.add(key); else next.delete(key);
      return next;
    });
  }, []);

  // A phone has no room beside the chat it opens: the notice gets out of the way.
  const open = useCallback((item: InterruptedTurn) => {
    if (phone) minimize(false);
    revealNode(item.nodeId, { workspaceId: item.workspaceId });
  }, [revealNode, phone, minimize]);

  const resume = useCallback((item: InterruptedTurn) => {
    settle(interruptedTurnKey(item), true);
    open(item);
    setPendingResume(item);
  }, [open, settle]);

  // The chat may live in a thread this window has not loaded: Resume once its receipt is in.
  const pendingState = pendingResume ? interruptedTurnState(outcomes[pendingResume.nodeId], pendingResume.turnId) : null;
  useEffect(() => {
    if (!pendingResume) return;
    if (pendingState === 'ready') {
      setPendingResume(null);
      resumeLastTurn(pendingResume.nodeId);
      return;
    }
    if (pendingState === 'moved-on') {
      setPendingResume(null);
      return;
    }
    const timeout = setTimeout(() => {
      setPendingResume(null);
      settle(interruptedTurnKey(pendingResume), false);
      toast.error('The chat is open, but its interrupted turn has not loaded yet. Press Resume in the chat.');
    }, RESUME_WAIT_MS);
    return () => clearTimeout(timeout);
  }, [pendingResume, pendingState, resumeLastTurn, settle]);

  // In place, without opening each chat: every node is in the store (hydration
  // reads every workspace's nodes and their last turn's receipt).
  const resumeAll = useCallback((targets: readonly InterruptedTurn[]) => {
    const left: string[] = [];
    for (const item of targets) {
      if (interruptedTurnState(outcomes[item.nodeId], item.turnId) !== 'ready') {
        left.push(item.title);
        continue;
      }
      settle(interruptedTurnKey(item), true);
      resumeLastTurn(item.nodeId);
    }
    if (left.length > 0) toast.error(`Not loaded here yet, open to resume: ${left.slice(0, 2).map((title) => `“${title}”`).join(', ')}${left.length > 2 ? ` and ${left.length - 2} more` : ''}.`);
  }, [outcomes, resumeLastTurn, settle]);

  const dismiss = useCallback((targets: readonly InterruptedTurn[]) => {
    // One row leaving: the keyboard goes on to the next one (or the one before).
    if (targets.length === 1) {
      const at = keys.indexOf(interruptedTurnKey(targets[0]));
      setFocusRow(keys[at + 1] ?? keys[at - 1] ?? null);
    }
    for (const item of targets) settle(interruptedTurnKey(item), true);
    void Promise.allSettled(targets.map((item) => dismissInterruptedTurn(item))).then((results) => {
      const failed = targets.filter((_, index) => results[index].status === 'rejected');
      if (failed.length === 0) return;
      for (const item of failed) settle(interruptedTurnKey(item), false);
      toast.error(failed.length === 1 ? `Could not dismiss “${failed[0].title}”.` : `Could not dismiss ${failed.length} tasks.`);
    });
  }, [settle, keys]);

  const rows = showAll ? visible : visible.slice(0, COLLAPSED_ROWS);
  const hidden = visible.length - rows.length;
  return (
    <AnimatePresence initial={false} mode="wait">
      {visible.length > 0 && (minimized ? (
        <NoticeMotion key="interrupted-tab" noticeKey="interrupted-tab">
          <NoticeTab
            tone="interrupted"
            icon={<CirclePause size={14} />}
            count={visible.length}
            label={`Show ${visible.length === 1 ? 'the interrupted task' : `${visible.length} interrupted tasks`}`}
            onExpand={expand}
            focusOnMount={focus === 'tab'}
            onFocused={focusDone}
          />
        </NoticeMotion>
      ) : (
        <NoticeMotion key="interrupted" noticeKey="interrupted">
          <InterruptedCard onMinimize={minimize}>
            {(cardId, hintId) => (
              <>
                <NoticeHeader
                  tone="interrupted"
                  icon={<CirclePause size={14} />}
                  title="Interrupted"
                  count={visible.length}
                  cardId={cardId}
                  minimizeLabel="Shrink the interrupted tasks notice"
                  onMinimize={minimize}
                  focusTitle={focus === 'card'}
                  onFocused={focusDone}
                />
                <ul ref={list} className={`interrupted-notice-list term-scrollbar${showAll ? ' interrupted-notice-list--all' : ''}`}>
                  {rows.map((item) => (
                    <InterruptedRow
                      key={interruptedTurnKey(item)}
                      item={item}
                      hintId={hintId}
                      showWorkspace={projects.length > 1}
                      onResume={resume}
                      onOpen={open}
                      onDismiss={(target) => dismiss([target])}
                    />
                  ))}
                </ul>
                <div className="shell-notice-foot">
                  {visible.length > 1 && (
                    <Button variant="primary" size="sm" title={RESUME_HINT} aria-describedby={hintId} onClick={() => resumeAll(visible)}>
                      Resume all
                    </Button>
                  )}
                  {(hidden > 0 || showAll) && (
                    <Button variant="ghost" size="sm" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>
                      {showAll ? 'Fewer' : `All ${visible.length}`}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" className="shell-notice-end" onClick={() => dismiss(visible)}>
                    {visible.length === 1 ? 'Dismiss' : 'Dismiss all'}
                  </Button>
                </div>
              </>
            )}
          </InterruptedCard>
        </NoticeMotion>
      ))}
    </AnimatePresence>
  );
}

/** The card; while it leaves it is no longer a target. Esc inside it shrinks it. */
function InterruptedCard({ onMinimize, children }: {
  onMinimize: () => void;
  children: (cardId: string, hintId: string) => React.ReactNode;
}) {
  const present = useIsPresent();
  const cardId = useId();
  const hintId = useId();
  return (
    <section
      id={cardId}
      className="shell-notice shell-notice--interrupted"
      aria-label="Interrupted tasks"
      aria-hidden={present ? undefined : true}
      inert={!present}
      onKeyDown={shrinkOnEscape(onMinimize)}
    >
      {children(cardId, hintId)}
      <span id={hintId} className="sr-only">{RESUME_HINT}</span>
    </section>
  );
}

function InterruptedRow({ item, hintId, showWorkspace, onResume, onOpen, onDismiss }: {
  item: InterruptedTurn;
  hintId: string;
  showWorkspace: boolean;
  onResume: (item: InterruptedTurn) => void;
  onOpen: (item: InterruptedTurn) => void;
  onDismiss: (item: InterruptedTurn) => void;
}) {
  return (
    <li className="interrupted-notice-item" data-row-key={interruptedTurnKey(item)}>
      <span className="interrupted-notice-item-main">
        <button type="button" className="interrupted-notice-item-title" title={`Open ${item.title}`} onClick={() => onOpen(item)}>
          {item.title}
        </button>
        <span className="interrupted-notice-item-meta">
          {showWorkspace && item.workspaceName ? `${item.workspaceName} · ` : ''}{relativeTime(item.interruptedAt)}
        </span>
      </span>
      <Button size="sm" className="interrupted-notice-resume" title={RESUME_HINT} aria-label={`Resume ${item.title}`} aria-describedby={hintId} onClick={() => onResume(item)}>
        Resume
      </Button>
      <button type="button" className="t-icon-btn shell-notice-icon interrupted-notice-dismiss" aria-label={`Dismiss ${item.title}`} title="Dismiss" onClick={() => onDismiss(item)}>
        <X size={14} aria-hidden="true" />
      </button>
    </li>
  );
}
