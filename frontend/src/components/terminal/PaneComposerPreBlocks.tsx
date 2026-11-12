import { useState, useRef, useEffect } from 'react';
import { AnimatePresence, motion, useIsPresent, type TargetAndTransition } from 'motion/react';
import type { ChatNodeState, PendingQueuedMessage } from '../../state/chatTypes';
import { buildSlashEntries, resolveSlashRun, type SlashEntry } from '../../state/slashEntries';
import { artifactHasImagePreview } from 'michi-shared';
import { attachmentImageUrl } from '../../services/api/artifacts';
import { EASE } from '../../motion/tokens';
import { AssistantAttachmentsPreBlock } from './assistant/AssistantAttachments';
import { isImeComposing } from '../../lib/ime';

/** A queued block leaving folds away; its bubble fades in in the transcript. */
const QUEUED_EXIT: TargetAndTransition = {
  opacity: 0,
  height: 0,
  marginTop: 0,
  paddingTop: 0,
  paddingBottom: 0,
  overflow: 'hidden',
  transition: { duration: 0.2, ease: EASE.drawer, opacity: { duration: 0.08, ease: 'linear' } },
};

const NO_QUEUE: readonly PendingQueuedMessage[] = [];
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
  onEditPendingComment,
  onRemovePendingComment,
  onDismissQuote,
  onRemovePendingAttachment,
}: PaneComposerPreBlocksProps) {
  const queued = node.pendingQueued ?? NO_QUEUE;
  const runOf = (entry: PendingQueuedMessage) => resolveSlashRun(entry.value, slashEntries ?? LOCAL_SLASH_ENTRIES, entry.slash?.entry)?.kind;

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
              steerable={canSteerQueued && !isErrored && runOf(q) !== 'skill'}
              steerDisabled={steeringQueueId !== null || queued.some((entry) => entry.steering)}
              steering={steeringQueueId === q.id || !!q.steering}
              onSteer={onSteerQueued}
              onRestore={onRestoreQueued}
            />
          );
        })}
      </AnimatePresence>

      {(node.pendingComments ?? []).map((c, i) => (
        <EditableCommentChip
          key={c.id}
          index={i}
          quotedText={c.quotedText}
          body={c.body}
          source={c.source}
          onEdit={(body) => onEditPendingComment(c.id, body)}
          onRemove={() => onRemovePendingComment(c.id)}
        />
      ))}

      {quotedText && (
        <div className="t-pre-block tone-accent">
          <div className="t-pre-block-col">
            <div className="t-pre-block-cap">
              replying to <b>selection</b>
              {node.composerDraft?.quoteSource?.type === 'artifact' ? (
                <span> · {node.composerDraft.quoteSource.name || node.composerDraft.quoteSource.filePath} · {node.composerDraft.quoteSource.snapshot?.contentHash.slice(0, 8) || 'version unknown'}</span>
              ) : null}
            </div>
            <div
              className={quoteMaxLines > 1 ? 't-pre-block-body is-multi' : 't-pre-block-body'}
              style={quoteMaxLines > 1 ? { WebkitLineClamp: quoteMaxLines } : undefined}
            >
              {quotedText.replace(/\s+/g, ' ').trim()}
            </div>
          </div>
          <button
            type="button"
            aria-label="Dismiss quote"
            className="t-pre-block-x"
            onClick={onDismissQuote}
          >
            ×
          </button>
        </div>
      )}

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
                ×
              </button>
            </span>
          );
        }

        return (
          <span key={p.id} className="t-att-pending-item t-att-pending-file t-reveal-host" title={p.absPath}>
            <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.7 }}>📄</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
              {p.name}
            </span>
            <button
              type="button"
              className="t-att-pending-x t-reveal"
              aria-label={`Remove ${p.name}`}
              onClick={() => onRemove(p.id)}
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** One queued message. While it leaves it is out of the a11y tree and inert. */
function QueuedBlock({ entry, index, errored, steerable, steerDisabled, steering, onSteer, onRestore }: {
  entry: PendingQueuedMessage;
  index: number;
  errored: boolean;
  steerable: boolean;
  steerDisabled: boolean;
  steering: boolean;
  onSteer: (queueId: string) => void;
  onRestore: (queueId: string) => void;
}) {
  const present = useIsPresent();
  const queueId = entry.id;
  const captionSuffix = index === 0
    ? (errored ? ' · paused, review and send manually' : ' · sends when stream ends')
    : '';
  return (
    <motion.div
      exit={QUEUED_EXIT}
      className={`t-pre-block ${errored ? 'tone-danger' : 'tone-select'}`}
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
          ×
        </button>
      </div>
    </motion.div>
  );
}

function EditableCommentChip({
  index,
  quotedText,
  body,
  source,
  onEdit,
  onRemove,
}: {
  index: number;
  quotedText: string;
  body: string;
  source?: NonNullable<ChatNodeState['pendingComments']>[number]['source'];
  onEdit: (body: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [editing]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== body) onEdit(trimmed);
    setEditing(false);
  };

  const cancel = () => {
    setDraft(body);
    setEditing(false);
  };

  return (
    <div
      className="t-pre-block tone-select"
      title={`"${quotedText}"\n\n${body}`}
    >
      <div className="t-pre-block-col">
        <div className="t-pre-block-cap">
          comment <b>{index + 1}</b>{index === 0 ? ' · pending on next send' : ''}
          {source ? <span> · {source.name || source.filePath} · {source.snapshot?.contentHash.slice(0, 8) || 'version unknown'}</span> : null}
        </div>
        <div className="t-pre-block-quoted">
          "{quotedText.replace(/\s+/g, ' ').trim()}"
        </div>
        {editing ? (
          <textarea
            ref={textareaRef}
            className="t-pre-block-edit-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isImeComposing(e)) {
                e.preventDefault();
                commit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            onBlur={commit}
            rows={2}
          />
        ) : (
          <div
            className="t-pre-block-reply is-editable"
            onClick={() => { setDraft(body); setEditing(true); }}
          >
            {body.replace(/\s+/g, ' ').trim()}
          </div>
        )}
      </div>
      <button
        type="button"
        aria-label="Remove pending comment"
        className="t-pre-block-x"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
