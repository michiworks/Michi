import React, { useCallback, useId, useMemo } from 'react';
import { CircleHelp } from 'lucide-react';
import { AnimatePresence, useIsPresent } from 'motion/react';
import { isAssistantConversation, useChatActions, useChatProjects, useStructuralSelector } from '../../state/chatStore';
import { useCompanionName } from '../../state/companion/companionName';
import {
  pendingAskUsersEqual,
  selectPendingAskUsers,
  type PendingAskUser,
} from '../../state/askUserSelectors';
import { WORKFLOW_NEEDS_YOU_CHIP } from './workflows/workflowPresentation';
import './workflows/runChip.css';
import { Button } from '../ui/controls';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { NoticeHeader, NoticeMotion, NoticeTab, shrinkOnEscape, useAnnounceNew, useNoticeMinimized } from './shellNoticeParts';

/**
 * Global "the agent is asking you something" reminder, in the shell's
 * notice corner (ShellNotices).
 *
 * The Ask User card renders inline in the pane's transcript, which is easy to
 * miss: the pane may be closed, in another thread/workspace, or scrolled far
 * above the fold. This notice shows on EVERY page for as long as any node has
 * an unanswered ask, and clicking it navigates to that node's pane and scrolls
 * the card into view.
 *
 * Deliberately not gated on the `notifications` pref — that pref governs
 * toasts / OS notifications (transient, dismissible), while this is a state
 * indicator that disappears only when the question is answered or skipped.
 * It can shrink to a tab; a new question opens it again. A new question is
 * read out politely (ShellNotices' live region), never as an alert that
 * interrupts typing.
 */
export default function AskUserNotice() {
  const { revealNode } = useChatActions();

  const pending = useStructuralSelector(selectPendingAskUsers, pendingAskUsersEqual);
  const keys = useMemo(() => pending.map((ask) => `${ask.nodeId}:${ask.requestId}`), [pending]);
  const { minimized, minimize, expand, focus, focusDone } = useNoticeMinimized(keys, { storageKey: 'ask' });
  // The agent's own conversation goes by its name, not a thread title (§1.5).
  const { projects } = useChatProjects();
  const name = useCompanionName();
  const labelFor = useCallback((target: PendingAskUser) => (
    isAssistantConversation(projects, target.nodeId) ? name : target.title || 'Untitled thread'
  ), [name, projects]);
  useAnnounceNew(keys, () => `Agent question: ${pending[0] ? labelFor(pending[0]) : 'Untitled thread'}`);
  // A phone has no room beside the chat it opens: the notice gets out of the way.
  const phone = usePhoneLayout();

  // The agent asks in its panel (e.g. approving a message it wants to send to
  // another thread), never in a pane of its hidden workspace: revealNode
  // routes its conversation there, as its notifications do (DESIGN-v2 §1.2).
  const reveal = useCallback((target: PendingAskUser) => {
    if (phone) minimize(false);
    revealNode(target.nodeId, { messageId: target.anchorMessageId ?? undefined });
  }, [revealNode, phone, minimize]);

  // Oldest unanswered ask is the click target; answering it promotes the next
  // one, so repeated clicks walk the queue without any local cursor state.
  return (
    <AnimatePresence initial={false} mode="wait">
      {pending.length > 0 && (minimized ? (
        <NoticeMotion key="ask-tab" noticeKey="ask-tab">
          <NoticeTab
            tone="ask"
            icon={<CircleHelp size={14} />}
            count={pending.length}
            label={`Show the agent's ${pending.length === 1 ? 'question' : `${pending.length} questions`}`}
            onExpand={expand}
            focusOnMount={focus === 'tab'}
            onFocused={focusDone}
          />
        </NoticeMotion>
      ) : (
        <NoticeMotion key="ask" noticeKey="ask">
          <AskNoticeCard
            next={pending[0]}
            label={labelFor(pending[0])}
            extra={pending.length - 1}
            reveal={reveal}
            onMinimize={minimize}
            focusTitle={focus === 'card'}
            onFocused={focusDone}
          />
        </NoticeMotion>
      ))}
    </AnimatePresence>
  );
}

function AskNoticeCard({ next, label, extra, reveal, onMinimize, focusTitle, onFocused }: {
  next: PendingAskUser;
  label: string;
  extra: number;
  reveal: (target: PendingAskUser) => void;
  onMinimize: () => void;
  focusTitle: boolean;
  onFocused: () => void;
}) {
  // While closing, the card keeps its last content but is no longer a
  // target: the ask it points to has been answered.
  const present = useIsPresent();
  const id = useId();
  return (
    // The nested Answer button carries the keyboard/AT action, while the whole
    // card stays clickable for the mouse.
    <section
      id={id}
      aria-label="Agent question"
      aria-hidden={present ? undefined : true}
      inert={!present}
      className="shell-notice shell-notice--ask ask-notice"
      onClick={present ? () => reveal(next) : undefined}
      onKeyDown={shrinkOnEscape(onMinimize)}
    >
      <NoticeHeader
        tone="ask"
        icon={<CircleHelp size={14} />}
        title={label}
        status={(
          <span className="run-chip" style={{ color: WORKFLOW_NEEDS_YOU_CHIP.color, background: WORKFLOW_NEEDS_YOU_CHIP.fill }}>
            <span aria-hidden className="term-dot-i" />{WORKFLOW_NEEDS_YOU_CHIP.label}
          </span>
        )}
        cardId={id}
        minimizeLabel="Shrink the question notice"
        onMinimize={onMinimize}
        focusTitle={focusTitle}
        onFocused={onFocused}
      />
      {next.question ? <p className="shell-notice-text ask-notice-question">{next.question}</p> : null}
      <div className="shell-notice-foot">
        <Button
          variant="primary"
          size="sm"
          className="ask-notice-cta"
          aria-label={`Open ${label} and answer the agent's question`}
          onClick={(e) => {
            e.stopPropagation();
            if (present) reveal(next);
          }}
        >
          Answer
        </Button>
        {extra > 0 && <span className="shell-notice-muted">+{extra} more</span>}
      </div>
    </section>
  );
}
