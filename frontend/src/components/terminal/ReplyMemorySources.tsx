import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Bookmark, ChevronDown } from 'lucide-react';
import type { ReplyMemorySource } from 'michi-shared';
import { deleteMemory, hideRecalledTurn, MemoryApiError } from '../../services/api/memories';
import { runSelfMutation } from '../../state/memory/memoryNotifications';
import { refreshReplySources, removeReplySource, useReplyMemorySources } from '../../state/memory/replySources';
import { openSourcePopover } from '../../state/sourceNav/sourceNav';
import { requestMemoryReveal } from './pages/settings/memoryReveal';
import './ReplyMemorySources.css';

/**
 * The quiet line under a settled reply: "Based on 2 things you told me", the
 * memories and past chats the reply repeated of what Michi gave the model in
 * this conversation (backend services/memory/replySources.ts). Collapsed by
 * default; expanded, each item says who saved it, when and where it came
 * from, with Forget and Edit for a memory and Don't recall for a past chat,
 * each confirmed first (they act on what the user asked for; nothing here
 * approves an AI action). Nothing renders without a source. It is not message
 * content: copy, export and share never include it.
 *
 * Touch: every control is a button, so a tap's hover reveals nothing
 * (MessageBlock's TAP_CONTROL), the line looks the same at rest and hovered,
 * and controls get 44 px targets on a coarse pointer.
 */

const TOOLTIP = 'What Michi remembered for this reply. It may not list everything.';
/** The section's name, and the toggle's once everything it listed was forgotten (there is no "0" count). */
const SECTION_LABEL = 'What this reply was based on';
const DAY_MS = 86_400_000;

export function replySourcesLabel(count: number): string {
  return `Based on ${count} thing${count === 1 ? '' : 's'} you told me`;
}

/** Who saved it, as the meta line says. */
export function sourceWho(source: ReplyMemorySource): string {
  if (source.kind === 'conversation') return 'From a past chat';
  if (source.savedBy === 'user') return 'Saved by you';
  if (source.savedBy === 'import') {
    return source.importSource === 'claude' ? 'From Claude Code' : source.importSource === 'codex' ? 'From Codex'
      : source.importSource === 'kiro' ? 'From Kiro' : 'Imported';
  }
  return 'Noted by Michi';
}

/** today, yesterday, Nov 6, or Nov 6, 2025 in another year. */
export function sourceDate(at: number, now: Date = new Date()): string {
  const date = new Date(at);
  if (!Number.isFinite(at) || Number.isNaN(date.getTime())) return '';
  const day = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / DAY_MS);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  return date.getFullYear() === now.getFullYear() ? `${month} ${date.getDate()}` : `${month} ${date.getDate()}, ${date.getFullYear()}`;
}

function keyOf(source: ReplyMemorySource): string {
  return source.kind === 'memory' ? `m:${source.memoryId}` : `c:${source.docId}`;
}

/** A 404 means it is gone already: the user's wish holds. */
function alreadyGone(error: unknown): boolean {
  return error instanceof MemoryApiError && error.status === 404;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

interface Forgotten {
  key: string;
  /** Where it was listed, so its status line takes its place. */
  index: number;
  text: string;
}

export function ReplyMemorySources({ messageId, settled }: { messageId: string; settled: boolean }) {
  const { target, sources } = useReplyMemorySources(messageId, settled);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; text: string } | null>(null);
  const [forgotten, setForgotten] = useState<Forgotten[]>([]);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  // Collapsing clears what the last expansion said; opening asks again, so the list is current.
  const apiBase = target?.apiBase ?? null;
  const nodeId = target?.nodeId ?? null;
  useEffect(() => {
    if (open) {
      if (apiBase && nodeId) refreshReplySources({ apiBase, nodeId }, messageId);
      return;
    }
    setConfirming(null);
    setFailed(null);
    setForgotten([]);
  }, [open, apiBase, nodeId, messageId]);

  const focusToggle = useCallback(() => {
    requestAnimationFrame(() => toggleRef.current?.focus());
  }, []);

  if (!target || (sources.length === 0 && (!open || forgotten.length === 0))) return null;

  const act = async (source: ReplyMemorySource, index: number) => {
    const key = keyOf(source);
    setBusy(key);
    setFailed(null);
    try {
      if (source.kind === 'memory') {
        await runSelfMutation(source.memoryId, () => deleteMemory(source.memoryId, target.apiBase)).catch((error: unknown) => {
          if (!alreadyGone(error)) throw error;
        });
      } else {
        await hideRecalledTurn(target.apiBase, source.docId).catch((error: unknown) => {
          if (!alreadyGone(error)) throw error;
        });
      }
      setForgotten((current) => [...current, { key, index, text: source.kind === 'memory' ? 'Forgotten.' : 'Michi won’t recall this again.' }]);
      setConfirming(null);
      removeReplySource(target, messageId, source);
    } catch (error) {
      setFailed({ key, text: source.kind === 'memory' ? `Couldn’t forget it: ${errorText(error)}` : `Couldn’t stop recalling it: ${errorText(error)}` });
    } finally {
      setBusy(null);
      focusToggle();
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    if (!confirming && !open) return;
    event.stopPropagation();
    event.preventDefault();
    if (confirming) setConfirming(null);
    else setOpen(false);
    focusToggle();
  };

  // The items as listed, with a status line where one was just forgotten.
  const rows: Array<{ kind: 'source'; source: ReplyMemorySource; index: number } | { kind: 'done'; item: Forgotten }> = sources.map((source, index) => ({ kind: 'source', source, index }));
  for (const item of [...forgotten].sort((a, b) => a.index - b.index)) rows.splice(Math.min(item.index, rows.length), 0, { kind: 'done', item });

  return (
    <section className="t-reply-sources" aria-label={SECTION_LABEL} onKeyDown={onKeyDown} data-open={open ? 'true' : undefined}>
      <button
        ref={toggleRef}
        type="button"
        className="t-reply-sources-toggle"
        aria-expanded={open}
        aria-controls={listId}
        title={TOOLTIP}
        onClick={() => setOpen((value) => !value)}
      >
        <Bookmark size={12} aria-hidden="true" />
        <span>{sources.length > 0 ? replySourcesLabel(sources.length) : SECTION_LABEL}</span>
        <ChevronDown size={12} aria-hidden="true" className="t-reply-sources-chevron" />
      </button>
      {open && (
        <ul id={listId} className="t-reply-sources-list">
          {rows.map((row) => {
            if (row.kind === 'done') {
              return <li key={`done-${row.item.key}`} className="t-reply-sources-item t-reply-sources-done" role="status">{row.item.text}</li>;
            }
            const { source, index } = row;
            const key = keyOf(source);
            const date = sourceDate(source.at);
            const from = source.from && source.from.title ? source.from : null;
            const isMemory = source.kind === 'memory';
            const confirm = confirming === key;
            return (
              <li key={key} className="t-reply-sources-item">
                <p className="t-reply-sources-text">{isMemory ? source.text : `“${source.text}”`}</p>
                <p className="t-reply-sources-meta">
                  <span>{sourceWho(source)}</span>
                  {date && <><span aria-hidden="true"> · </span><span>{date}</span></>}
                  {from && (
                    <>
                      <span aria-hidden="true"> · </span>
                      <button
                        type="button"
                        className="t-reply-sources-link"
                        onClick={(event) => openSourcePopover({
                          target: { backendConnectionId: target.backendConnectionId, workspaceId: target.workspaceId, nodeId: from.nodeId, messageId: from.messageId },
                          anchor: event.currentTarget,
                        })}
                      >
                        {from.title}
                      </button>
                    </>
                  )}
                </p>
                <div className="t-reply-sources-actions">
                  {confirm ? (
                    <>
                      <button type="button" className="t-reply-sources-action t-reply-sources-danger" disabled={busy === key}
                        onClick={() => { void act(source, index); }}>
                        {isMemory ? 'Confirm forget' : 'Confirm'}
                      </button>
                      <button type="button" className="t-reply-sources-action" disabled={busy === key} onClick={() => setConfirming(null)}>Keep</button>
                    </>
                  ) : (
                    <>
                      {isMemory && target.local && (
                        <button type="button" className="t-reply-sources-action"
                          onClick={() => requestMemoryReveal({ id: source.memoryId, body: source.text })}>Edit</button>
                      )}
                      <button type="button" className="t-reply-sources-action" onClick={() => { setFailed(null); setConfirming(key); }}>
                        {isMemory ? 'Forget' : 'Don’t recall'}
                      </button>
                    </>
                  )}
                </div>
                {failed?.key === key && <p className="t-reply-sources-error" role="alert">{failed.text}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
