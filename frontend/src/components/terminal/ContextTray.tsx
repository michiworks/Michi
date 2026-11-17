import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { AnimatePresence, useIsPresent } from 'motion/react';
import type { PendingComment } from '../../state/chatTypes';
import { isImeComposing } from '../../lib/ime';
import { useBackLayer } from '../../lib/backStack';
import { useFresh } from '../../motion/useFresh';
import { PopoverSurface } from '../ui/Popover';
import { useAnchoredPosition } from '../ui/useAnchoredPosition';
import { CommentGlyph, CtxRemoveButton, oneLine, ReplyGlyph, sourceMeta } from './ContextItem';
import { CloseIcon } from './icons';
import { focusPaneComposer } from './paneFocus';

/**
 * What travels with the next send, as one row of chips in the composer
 * (.t-ctx-tray in index.css): each pending comment, then the quote. A chip
 * is an attachment's height and shows the start of what it carries (a
 * comment's passage and the person's note, the quote's passage); about three
 * fit across the composer and the rest scroll sideways, so the composer
 * never grows past this one row. A chip opens the full list as a card above
 * the composer, where a note is edited and a passage read whole.
 */

/** The quote's key among the tray's items; comments go by their ids. */
const QUOTE = 'quote';
/** The card's distance from the composer under it and from the pane's top. */
const GAP = 8;
const PAD = 8;
/** Short of this room above the composer, the card scrolls inside this height. */
const MIN_CARD_HEIGHT = 160;
/** Lines one wheel notch scrolls when the wheel counts in lines (WheelEvent.DOM_DELTA_LINE). */
const LINE_PX = 16;

export interface ContextTrayProps {
  comments: readonly PendingComment[];
  quotedText: string | null;
  /** The file the quote came from, when it came from one. */
  quoteMeta: string | null;
  /** The reader's quoteMaxLines pref, for the quote's row in the card. */
  quoteMaxLines: number;
  /** A quote has no timestamp: it is new when it appears after the composer mounted. */
  afterMount: RefObject<boolean>;
  onEditComment: (commentId: string, body: string) => void;
  onRemoveComment: (commentId: string) => void;
  onDismissQuote: () => void;
}

export function ContextTray({
  comments,
  quotedText,
  quoteMeta,
  quoteMaxLines,
  afterMount,
  onEditComment,
  onRemoveComment,
  onDismissQuote,
}: ContextTrayProps) {
  const [tray, setTray] = useState<HTMLDivElement | null>(null);
  const rowRef = useRef<HTMLOListElement>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const cardId = useId();
  const keys = comments.map((c) => c.id);
  if (quotedText) keys.push(QUOTE);
  const count = keys.length;
  const edges = useOverflowEdges(rowRef, keys.join('\n'));
  useWheelScrollsRow(rowRef, count > 0);

  // Everything was sent or removed: the card goes with the tray.
  useEffect(() => { if (count === 0) setOpenKey(null); }, [count]);

  // A chip removed from the row hands the keyboard to the chip that took its
  // place, in the commit that removes it (ST-10).
  const refocusRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = refocusRef.current;
    if (index === null) return;
    refocusRef.current = null;
    const chips = chipButtons(rowRef.current);
    chips[Math.min(index, chips.length - 1)]?.focus();
  });

  const removeChip = (index: number, remove: () => void) => {
    // The last chip takes the tray with it: the composer is what is left.
    if (count === 1) focusPaneComposer(tray);
    else refocusRef.current = index;
    remove();
  };

  const closeCard = (refocus = true) => {
    if (refocus) {
      const chip = chipButtons(rowRef.current).find((button) => button.closest('[data-ctx-key]')?.getAttribute('data-ctx-key') === openKey)
        ?? chipButtons(rowRef.current)[0];
      if (chip) chip.focus({ preventScroll: true });
      else focusPaneComposer(tray);
    }
    setOpenKey(null);
  };

  const removeInCard = (remove: () => void) => {
    if (count === 1) {
      focusPaneComposer(tray);
      setOpenKey(null);
    }
    remove();
  };

  if (count === 0) return null;
  // The open chip closes its card; another chip moves the card to its item.
  const toggle = (key: string) => {
    if (openKey === key) closeCard();
    else setOpenKey(key);
  };

  return (
    <div
      ref={setTray}
      className="t-ctx-tray"
      role="group"
      aria-label="Sent with your message"
      data-overflow={edges || undefined}
    >
      <ol ref={rowRef} className="t-ctx-tray-row">
        {comments.map((c, i) => (
          <CommentTrayChip
            key={c.id}
            comment={c}
            open={openKey === c.id}
            cardId={cardId}
            onOpen={() => toggle(c.id)}
            onRemove={() => removeChip(i, () => onRemoveComment(c.id))}
          />
        ))}
        {quotedText && (
          <QuoteTrayChip
            key={QUOTE}
            text={quotedText}
            meta={quoteMeta}
            afterMount={afterMount}
            open={openKey === QUOTE}
            cardId={cardId}
            onOpen={() => toggle(QUOTE)}
            onRemove={() => removeChip(comments.length, onDismissQuote)}
          />
        )}
      </ol>
      <AnimatePresence>
        {openKey !== null && (
          <ContextCard
            key="card"
            id={cardId}
            tray={tray}
            target={openKey}
            comments={comments}
            quotedText={quotedText}
            quoteMeta={quoteMeta}
            quoteMaxLines={quoteMaxLines}
            onEditComment={onEditComment}
            onRemoveComment={(id) => removeInCard(() => onRemoveComment(id))}
            onDismissQuote={() => removeInCard(onDismissQuote)}
            onClose={closeCard}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * What a comment's controls are named by: the person's note, or the passage
 * when they left none. Comments carry no number (the list's order and count
 * say it, and the agent reads them without one).
 */
function commentName(comment: PendingComment): string {
  return oneLine(comment.body) || oneLine(comment.quotedText);
}

/** The row's chip buttons, in order. */
function chipButtons(row: HTMLElement | null): HTMLButtonElement[] {
  return row ? [...row.querySelectorAll<HTMLButtonElement>('.t-ctx-chip-open')] : [];
}

/**
 * Which ends of the row have chips scrolled past them ("start", "end", both
 * or neither), so the row fades out where there is more to see.
 */
function useOverflowEdges(rowRef: RefObject<HTMLElement | null>, contentKey: string): string {
  const [edges, setEdges] = useState('');
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      const max = row.scrollWidth - row.clientWidth;
      const next = [row.scrollLeft > 1 && 'start', row.scrollLeft < max - 1 && 'end'].filter(Boolean).join(' ');
      setEdges((current) => (current === next ? current : next));
    };
    measure();
    row.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(row);
    return () => {
      row.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [rowRef, contentKey]);
  return edges;
}

/**
 * A mouse wheel turns the row while it has chips out of view; a trackpad's
 * sideways swipe and Shift+wheel already do. At either end the wheel goes
 * back to whatever it scrolled before.
 */
function useWheelScrollsRow(rowRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !active) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const max = row.scrollWidth - row.clientWidth;
      if (max <= 0) return;
      const step = event.deltaMode === 1 ? event.deltaY * LINE_PX : event.deltaY;
      const next = Math.max(0, Math.min(max, row.scrollLeft + step));
      if (next === row.scrollLeft) return;
      event.preventDefault();
      row.scrollLeft = next;
    };
    row.addEventListener('wheel', onWheel, { passive: false });
    return () => row.removeEventListener('wheel', onWheel);
  }, [rowRef, active]);
}

/** One chip: opens the card on its item; its × (a hover reveal) removes the item. */
function TrayChip({ itemKey, kind, fresh, open, cardId, label, title, mark, head, text, removeLabel, onOpen, onRemove }: {
  itemKey: string;
  kind: 'comment' | 'quote';
  fresh: boolean;
  open: boolean;
  cardId: string;
  label: string;
  title: string;
  /** Its kind, in its colour: a comment's speech bubble, a quote's arrow. */
  mark: ReactNode;
  head: ReactNode;
  text: string;
  removeLabel: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  return (
    <li
      className={`t-ctx-chip is-${kind} t-reveal-host${open ? ' is-open' : ''}`}
      data-ctx-key={itemKey}
      data-fresh={fresh || undefined}
      title={title}
    >
      <button
        type="button"
        className="t-ctx-chip-open"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        onClick={onOpen}
      >
        <span className="t-ctx-chip-head">
          <span className="t-ctx-chip-mark" aria-hidden>{mark}</span>
          {head}
        </span>
        <span className="t-ctx-chip-text">{text}</span>
      </button>
      <button type="button" className="t-ctx-chip-x t-reveal" aria-label={removeLabel} onClick={onRemove}>
        <CloseIcon size="sm" />
      </button>
    </li>
  );
}

function CommentTrayChip({ comment, open, cardId, onOpen, onRemove }: {
  comment: PendingComment;
  open: boolean;
  cardId: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const fresh = useFresh(comment.createdAt);
  const note = oneLine(comment.body);
  const named = commentName(comment);
  return (
    <TrayChip
      itemKey={comment.id}
      kind="comment"
      fresh={fresh}
      open={open}
      cardId={cardId}
      label={`Comment: ${named}`}
      title={`"${comment.quotedText}"\n\n${comment.body}`}
      mark={<CommentGlyph />}
      head={<span className="t-ctx-chip-excerpt">{oneLine(comment.quotedText)}</span>}
      text={note}
      removeLabel={`Remove comment: ${named}`}
      onOpen={onOpen}
      onRemove={onRemove}
    />
  );
}

function QuoteTrayChip({ text, meta, afterMount, open, cardId, onOpen, onRemove }: {
  text: string;
  meta: string | null;
  afterMount: RefObject<boolean>;
  open: boolean;
  cardId: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [fresh] = useState(() => afterMount.current);
  const passage = oneLine(text);
  return (
    <TrayChip
      itemKey={QUOTE}
      kind="quote"
      fresh={fresh}
      open={open}
      cardId={cardId}
      label={`Quote: ${passage}`}
      title={text}
      mark={<ReplyGlyph />}
      head={<span className="t-ctx-chip-label">{meta ? `Replying to · ${meta}` : 'Replying to'}</span>}
      text={passage}
      removeLabel="Dismiss quote"
      onOpen={onOpen}
      onRemove={onRemove}
    />
  );
}

interface CardPlace { left: number; bottom: number; width: number; maxHeight: number }

/**
 * The tray's items in full, in a card over the transcript above the
 * composer, as wide as the composer: the comments with their
 * editable notes, then the quote. It opens on the chip's item, and closes on
 * Esc, a press outside it, its ×, or the phone's Back, handing the keyboard
 * back to the chip.
 */
function ContextCard({
  id,
  tray,
  target,
  comments,
  quotedText,
  quoteMeta,
  quoteMaxLines,
  onEditComment,
  onRemoveComment,
  onDismissQuote,
  onClose,
}: {
  id: string;
  tray: HTMLDivElement | null;
  target: string;
  comments: readonly PendingComment[];
  quotedText: string | null;
  quoteMeta: string | null;
  quoteMaxLines: number;
  onEditComment: (commentId: string, body: string) => void;
  onRemoveComment: (commentId: string) => void;
  onDismissQuote: () => void;
  onClose: (refocus?: boolean) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<CardPlace | null>(null);
  // Inside the tray's <AnimatePresence> a closed card fades out for a moment;
  // meanwhile it stays put and takes no keys or presses.
  const present = useIsPresent();
  const presentRef = useRef(present);
  presentRef.current = present;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useBackLayer(present, { back: () => onCloseRef.current() });
  const anchor = tray?.closest<HTMLElement>('.terminal-composer') ?? tray;

  useAnchoredPosition({
    anchor,
    surfaceRef,
    measure: () => {
      if (!presentRef.current || !anchor) return;
      if (!anchor.isConnected) { onCloseRef.current(false); return; }
      const rect = anchor.getBoundingClientRect();
      const top = Math.max(PAD, (anchor.closest('.terminal-pane')?.getBoundingClientRect().top ?? 0) + PAD);
      const width = Math.min(rect.width, window.innerWidth - PAD * 2);
      const next: CardPlace = {
        left: Math.max(PAD, Math.min(window.innerWidth - width - PAD, rect.left)),
        bottom: window.innerHeight - rect.top + GAP,
        width,
        maxHeight: Math.max(MIN_CARD_HEIGHT, rect.top - GAP - top),
      };
      setPlace((current) => (current
        && current.left === next.left && current.bottom === next.bottom
        && current.width === next.width && current.maxHeight === next.maxHeight ? current : next));
    },
  });

  // Opens on the chip's item: in view, and its note ready to edit. It waits
  // for the placement above, because nothing inside a card still hidden
  // (below) can take the keyboard.
  const placed = place !== null;
  useEffect(() => {
    if (!placed) return;
    const row = [...(surfaceRef.current?.querySelectorAll<HTMLElement>('[data-ctx-key]') ?? [])]
      .find((el) => el.getAttribute('data-ctx-key') === target);
    row?.scrollIntoView?.({ block: 'nearest' });
    const note = row?.querySelector<HTMLButtonElement>('button.t-ctx-note');
    (note ?? sinkRef.current)?.focus({ preventScroll: true });
  }, [target, placed]);

  useEffect(() => {
    if (!present) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeComposing(event)) return;
      // A note being edited takes its own Esc (it cancels the edit); the card stays.
      const from = event.target instanceof Element ? event.target : null;
      if (from?.closest('.t-ctx-edit') && surfaceRef.current?.contains(from)) return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    const onPointer = (event: PointerEvent) => {
      const node = event.target as Node | null;
      if (node && (surfaceRef.current?.contains(node) || tray?.contains(node))) return;
      // Focus inside goes back to the chip first, so a note being edited
      // saves; the press then puts it where it lands.
      onCloseRef.current(!!surfaceRef.current?.contains(document.activeElement));
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [present, tray]);

  // A removed row's × goes with it: the keyboard waits at the card's top.
  const removing = (remove: () => void) => () => {
    sinkRef.current?.focus({ preventScroll: true });
    remove();
  };

  const n = comments.length;
  const counted = n === 1 ? '1 comment' : `${n} comments`;
  const summary = n === 0 ? 'Quote' : quotedText ? `${counted} and a quote` : counted;

  return (
    <PopoverSurface
      ref={surfaceRef}
      role="dialog"
      aria-label="Sent with your message"
      escapeLayer="over"
      className="t-ctx-card"
      left={place?.left ?? 0}
      bottom={place?.bottom ?? 0}
      width={place?.width}
      maxHeight={place?.maxHeight}
      style={place ? undefined : { visibility: 'hidden' }}
    >
      {/* The composer's own click handling leaves this alone (ComposerShell):
          it is the composer's pre-blocks, floated out. */}
      <div id={id} className="t-ctx-card-body" data-composer-pre-block>
        <div ref={sinkRef} tabIndex={-1} className="t-ctx-card-sink" />
        <header className="t-ctx-card-head">
          <p className="t-ctx-cap">{summary} · sent with your message</p>
          <button type="button" className="t-ctx-btn t-ctx-card-close" aria-label="Close" onClick={() => onClose()}>
            <CloseIcon size="sm" />
          </button>
        </header>
        {n > 0 && (
          <ol className="t-ctx-rows">
            {comments.map((c) => (
              <PendingCommentRow
                key={c.id}
                comment={c}
                target={c.id === target}
                onEdit={(body) => onEditComment(c.id, body)}
                onRemove={removing(() => onRemoveComment(c.id))}
              />
            ))}
          </ol>
        )}
        {quotedText && (
          <div className="t-ctx is-quote t-reveal-host" data-ctx-key={QUOTE} data-target={target === QUOTE || undefined}>
            <span className="t-ctx-mark" title="Replying to this passage">
              <ReplyGlyph />
              <span className="sr-only">Replying to selection</span>
            </span>
            <div className="t-ctx-line">
              <span className="t-ctx-excerpt is-clamped" style={{ WebkitLineClamp: Math.max(1, quoteMaxLines) }}>
                {oneLine(quotedText)}
              </span>
              {quoteMeta && <span className="t-ctx-meta">{quoteMeta}</span>}
            </div>
            <CtxRemoveButton label="Dismiss quote" onClick={removing(onDismissQuote)} />
          </div>
        )}
      </div>
    </PopoverSurface>
  );
}

/**
 * One pending comment in the card: its mark, the passage, the person's note, which
 * opens a field in place to edit it, and its ×.
 */
function PendingCommentRow({ comment, target, onEdit, onRemove }: {
  comment: PendingComment;
  target: boolean;
  onEdit: (body: string) => void;
  onRemove: () => void;
}) {
  const { quotedText, body, source } = comment;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Closed from the keyboard (⌘↵ or Esc), the field hands focus to the note
  // it replaced, in the commit that removes it (ST-10). A blur commit leaves
  // focus where it went.
  const rootRef = useRef<HTMLLIElement>(null);
  const keyClosedRef = useRef(false);
  useLayoutEffect(() => {
    if (editing || !keyClosedRef.current) return;
    keyClosedRef.current = false;
    rootRef.current?.querySelector<HTMLButtonElement>('button.t-ctx-note')?.focus();
  }, [editing]);
  const meta = sourceMeta(source, false);

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
    <li
      ref={rootRef}
      className="t-ctx is-comment t-reveal-host"
      data-ctx-key={comment.id}
      data-target={target || undefined}
      title={`"${quotedText}"\n\n${body}`}
    >
      <span className="t-ctx-mark" aria-hidden><CommentGlyph /></span>
      <div className="t-ctx-line">
        <span className="t-ctx-excerpt">{oneLine(quotedText)}</span>
        {meta && <span className="t-ctx-meta">{meta}</span>}
      </div>
      <CtxRemoveButton label={`Remove comment: ${commentName(comment)}`} onClick={onRemove} />
      {editing ? (
        <textarea
          ref={textareaRef}
          className="t-ctx-edit"
          aria-label="Edit comment"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isImeComposing(e)) {
              e.preventDefault();
              keyClosedRef.current = true;
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              keyClosedRef.current = true;
              cancel();
            }
          }}
          onBlur={commit}
          rows={2}
        />
      ) : (
        <button
          type="button"
          className="t-ctx-note is-editable"
          aria-label={`Edit comment: ${oneLine(body)}`}
          onClick={() => { setDraft(body); setEditing(true); }}
        >
          {body.trim()}
        </button>
      )}
    </li>
  );
}
