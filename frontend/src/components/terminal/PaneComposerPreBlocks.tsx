import { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotionConfig, type TargetAndTransition } from 'motion/react';
import type { ChatNodeState, PendingComment, PendingQueuedMessage } from '../../state/chatTypes';
import { buildSlashEntries, resolveSlashRun, type SlashEntry } from '../../state/slashEntries';
import { artifactHasImagePreview } from 'michi-shared';
import { attachmentImageUrl } from '../../services/api/artifacts';
import { DUR, EASE } from '../../motion/tokens';
import { useFresh } from '../../motion/useFresh';
import { AssistantAttachmentsPreBlock } from './assistant/AssistantAttachments';
import { CloseIcon, FileIcon } from './icons';
import { sourceMeta } from './ContextItem';
import { ContextTray } from './ContextTray';

const QUEUED_FADE_OUT = { duration: DUR.dismiss, ease: 'linear' } as const;

/** A queued block leaving folds away; its bubble fades in in the transcript. */
const QUEUED_EXIT: TargetAndTransition = {
  opacity: 0,
  height: 0,
  marginTop: 0,
  paddingTop: 0,
  paddingBottom: 0,
  overflow: 'hidden',
  transition: { duration: 0.2, ease: EASE.drawer, opacity: QUEUED_FADE_OUT },
};

/** Reduced motion snaps the height but would still fold the margin and padding, so the block only fades. */
const QUEUED_EXIT_REDUCED: TargetAndTransition = { opacity: 0, transition: QUEUED_FADE_OUT };

const NO_QUEUE: readonly PendingQueuedMessage[] = [];
const NO_COMMENTS: readonly PendingComment[] = [];
const LOCAL_SLASH_ENTRIES = buildSlashEntries({});

export interface PanePendingAttachment {
  id: string;
  name: string;
  absPath: string;
  /** Workspace-relative path (e.g. ".attachments/img.png"). Present for uploaded files. */
  relPath?: string;
  /** Workspace whose folder holds the file; absent means the composer's own.
   *  The Home composer keeps its attachments across a workspace switch, so
   *  this can differ from the workspace the message goes to. */
  workspaceId?: string;
}

interface PaneComposerPreBlocksProps {
  node: ChatNodeState;
  quoteMaxLines: number;
  quotedText: string | null;
  pendingAttachments: readonly PanePendingAttachment[];
  /** The workspace the pending attachments were uploaded to: the pane's own, not the shell's. */
  workspaceId?: string;
  canSteerQueued: boolean;
  /** The chat's / entries: a queued message that runs a skill is a turn of its own, never steered. */
  slashEntries?: readonly SlashEntry[];
  steeringQueueId: string | null;
  onSteerQueued: (queueId: string) => void;
  onRestoreQueued: (queueId: string) => void;
  /** Send a paused queue now. */
  onSendQueuedNow: () => void;
  onEditPendingComment: (commentId: string, body: string) => void;
  onRemovePendingComment: (commentId: string) => void;
  onDismissQuote: () => void;
  onRemovePendingAttachment: (attachmentId: string) => void;
}

export function PaneComposerPreBlocks({
  node,
  quoteMaxLines,
  quotedText,
  pendingAttachments,
  workspaceId,
  canSteerQueued,
  slashEntries,
  steeringQueueId,
  onSteerQueued,
  onRestoreQueued,
  onSendQueuedNow,
  onEditPendingComment,
  onRemovePendingComment,
  onDismissQuote,
  onRemovePendingAttachment,
}: PaneComposerPreBlocksProps) {
  const queued = node.pendingQueued ?? NO_QUEUE;
  const runOf = (entry: PendingQueuedMessage) => resolveSlashRun(entry.value, slashEntries ?? LOCAL_SLASH_ENTRIES, entry.slash?.entry)?.kind;
  // A quote has no timestamp: it is new when it appears after the composer mounted.
  const mountedRef = useRef(false);
  useEffect(() => { mountedRef.current = true; }, []);
  const quoteMeta = sourceMeta(node.composerDraft?.quoteSource, false);

  return (
    <>
      <AssistantAttachmentsPreBlock nodeId={node.nodeId} />

      <AnimatePresence initial={false}>
        {queued.map((q, i) => {
          const isErrored = !!node.queueErrored;
          return (
            <QueuedBlock
              key={q.id}
              entry={q}
              index={i}
              errored={isErrored}
              stopped={!!node.queueStopped}
              onSendNow={isErrored && i === 0 && node.status !== 'streaming' ? onSendQueuedNow : undefined}
              steerable={canSteerQueued && !isErrored && runOf(q) !== 'skill'}
              steerDisabled={steeringQueueId !== null || queued.some((entry) => entry.steering)}
              steering={steeringQueueId === q.id || !!q.steering}
              onSteer={onSteerQueued}
              onRestore={onRestoreQueued}
            />
          );
        })}
      </AnimatePresence>

      <ContextTray
        comments={node.pendingComments ?? NO_COMMENTS}
        quotedText={quotedText}
        quoteMeta={quoteMeta}
        quoteMaxLines={quoteMaxLines}
        afterMount={mountedRef}
        onEditComment={onEditPendingComment}
        onRemoveComment={onRemovePendingComment}
        onDismissQuote={onDismissQuote}
      />

      <PendingAttachmentRow items={pendingAttachments} workspaceId={workspaceId} onRemove={onRemovePendingAttachment} />
    </>
  );
}

/** The composer's pending attachments: image thumbnails, other files as chips. */
export function PendingAttachmentRow({ items, workspaceId, onRemove }: {
  items: readonly PanePendingAttachment[];
  workspaceId?: string;
  onRemove: (attachmentId: string) => void;
}) {
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  if (items.length === 0) return null;
  return (
    <div className="t-att-pending-row">
      {items.map((p) => {
        const thumbSrc = artifactHasImagePreview(p.name) ? attachmentImageUrl(p.workspaceId ?? workspaceId, p) : null;

        if (thumbSrc && !broken.has(thumbSrc)) {
          return (
            <span key={p.id} title={p.name} className="t-att-pending-item t-reveal-host" style={{ display: 'inline-block' }}>
              <img
                src={thumbSrc}
                alt={p.name}
                onError={() => setBroken((prev) => new Set(prev).add(thumbSrc))}
                style={{ width: 64, height: 64, objectFit: 'cover', display: 'block' }}
              />
              <button
                type="button"
                className="t-att-pending-x t-reveal"
                aria-label={`Remove ${p.name}`}
                onClick={() => onRemove(p.id)}
              >
                <CloseIcon size="sm" />
              </button>
            </span>
          );
        }

        return (
          <span key={p.id} className="t-att-pending-item t-att-pending-file t-reveal-host" title={p.absPath}>
            <FileIcon size="sm" style={{ opacity: 0.7, flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
              {p.name}
            </span>
            <button
              type="button"
              className="t-att-pending-x t-reveal"
              aria-label={`Remove ${p.name}`}
              onClick={() => onRemove(p.id)}
            >
              <CloseIcon size="sm" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** One queued message. While it leaves it is out of the a11y tree and inert. */
function QueuedBlock({ entry, index, errored, stopped, onSendNow, steerable, steerDisabled, steering, onSteer, onRestore }: {
  entry: PendingQueuedMessage;
  index: number;
  /** The queue is paused: its turn errored, or was stopped (stopped). */
  errored: boolean;
  stopped: boolean;
  onSendNow?: () => void;
  steerable: boolean;
  steerDisabled: boolean;
  steering: boolean;
  onSteer: (queueId: string) => void;
  onRestore: (queueId: string) => void;
}) {
  const present = useIsPresent();
  const fresh = useFresh(entry.queuedAt);
  const reduced = useReducedMotionConfig() === true;
  const queueId = entry.id;
  const captionSuffix = index === 0
    ? (errored ? (stopped ? ' · paused after Stop' : ' · paused after an error') : ' · sends when stream ends')
    : '';
  return (
    <motion.div
      exit={reduced ? QUEUED_EXIT_REDUCED : QUEUED_EXIT}
      className={`t-pre-block ${errored && !stopped ? 'tone-danger' : 'tone-select'}`}
      data-fresh={fresh || undefined}
      aria-hidden={present ? undefined : true}
      inert={!present}
    >
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          queued <b>{index + 1}</b>{captionSuffix}
        </div>
        <div className="t-pre-block-body">
          {entry.value.replace(/\s+/g, ' ').trim()}
        </div>
      </div>
      <div className="t-pre-block-actions">
        {onSendNow && (
          <button type="button" className="t-pre-block-steer" onClick={onSendNow}>
            Send now
          </button>
        )}
        {steerable && (
          <button
            type="button"
            className="t-pre-block-steer"
            disabled={steerDisabled}
            onClick={() => onSteer(queueId)}
          >
            {steering ? 'Steering…' : 'Steer now'}
          </button>
        )}
        <button
          type="button"
          aria-label="Dequeue message"
          disabled={steering}
          className="t-pre-block-x"
          onClick={() => onRestore(queueId)}
        >
          <CloseIcon size="sm" />
        </button>
      </div>
    </motion.div>
  );
}
