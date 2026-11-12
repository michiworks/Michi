import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { ChatMessage } from '../../state/chatTypes';
import { formatMessageTime } from '../../lib/messageTime';
import {
  SCRUB_READING_LINE,
  fractionForScroll,
  fractionForThumb,
  lastAtOrAbove,
  scrubLabelText,
  scrubberAvailable,
  thumbCenter,
} from '../../lib/transcriptScrubber';
import './TranscriptScrubber.css';

/** Height of the visible grip; its centre travels the track minus this. */
const GRIP = 42;
/** The handle goes back in this long after the last scroll or release. */
const HIDE_MS = 1500;
/** A scroll this soon after touch or wheel input is the reader's (momentum included). */
const USER_INPUT_MS = 1200;
/** The current question's outline stays this long after release. */
const TARGET_LINGER_MS = 1000;

interface Question { el: HTMLElement; message: ChatMessage }
interface Label { index: number; total: number; text: string; time: string; dir?: 'next' | 'prev' }

interface TranscriptScrubberProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  messages: readonly ChatMessage[];
  /** Older history exists that is not loaded: the question count is a lower bound. */
  hasOlder: boolean;
  /** Track insets from the top and bottom of the pane body, px. */
  top: number;
  bottom: number;
  /** A drag starts or moves the transcript; the pane leaves follow mode and treats the scroll as the reader's. */
  onScrub: (phase: 'start' | 'move') => void;
}

/**
 * Phone fast scroller. While the reader scrolls a long conversation a handle
 * slides out of the transcript's right edge; held and dragged, it scrolls the
 * transcript in proportion to its position, and a bubble beside it names the
 * question at the reading line (a quarter of the way down) with its number
 * and time. Only the handle takes touches, and only while it is out, so
 * ordinary scrolling along the edge is unaffected.
 */
export function TranscriptScrubber({ scrollRef, messages, hasOlder, top, bottom, onScrub }: TranscriptScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(false);
  const [shown, setShown] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [label, setLabel] = useState<Label | null>(null);

  const users = useMemo(() => new Map(messages.filter((m) => m.role === 'user').map((m) => [m.id, m])), [messages]);
  const usersRef = useRef(users);
  const onScrubRef = useRef(onScrub);
  useLayoutEffect(() => {
    usersRef.current = users;
    onScrubRef.current = onScrub;
  });

  const drag = useRef({ active: false, grab: 0, trackTop: 0, index: -1, questions: [] as Question[] });
  const targetRef = useRef<HTMLElement | null>(null);
  const thumbY = useRef(GRIP / 2);
  const availableRef = useRef(false);
  const shownRef = useRef(false);
  const hideTimer = useRef(0);
  const targetTimer = useRef(0);
  const ignoreScrollUntil = useRef(0);
  const userInputUntil = useRef(0);

  const setTarget = useCallback((el: HTMLElement | null) => {
    if (targetRef.current === el) return;
    targetRef.current?.removeAttribute('data-scrub-target');
    el?.setAttribute('data-scrub-target', '');
    targetRef.current = el;
  }, []);
  const placeThumb = useCallback(() => {
    if (handleRef.current) handleRef.current.style.transform = `translateY(${thumbY.current}px)`;
  }, []);
  const placeBubble = useCallback(() => {
    const bubble = bubbleRef.current, track = trackRef.current;
    if (!bubble || !track) return;
    const h = bubble.offsetHeight;
    bubble.style.top = `${Math.max(0, Math.min(track.clientHeight - h, thumbY.current - h / 2 - 6))}px`;
  }, []);
  const syncThumb = useCallback(() => {
    const sc = scrollRef.current, track = trackRef.current;
    if (!sc || !track) return;
    thumbY.current = thumbCenter(fractionForScroll(sc.scrollTop, sc.scrollHeight - sc.clientHeight), track.clientHeight, GRIP);
    placeThumb();
  }, [scrollRef, placeThumb]);
  const checkAvailable = useCallback(() => {
    const sc = scrollRef.current;
    const ok = !!sc && scrubberAvailable(usersRef.current.size, sc.scrollHeight, sc.clientHeight);
    // The handle is the transcript's thumb while it is available, so the
    // native scroll indicator is hidden (TranscriptScrubber.css).
    sc?.toggleAttribute('data-scrubber', ok);
    availableRef.current = ok;
    setAvailable(ok);
    return ok;
  }, [scrollRef]);
  const show = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    if (!shownRef.current) { shownRef.current = true; setShown(true); }
  }, []);
  const scheduleHide = useCallback(() => {
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (drag.current.active) return;
      shownRef.current = false;
      setShown(false);
    }, HIDE_MS);
  }, []);

  useEffect(() => { checkAvailable(); }, [users, checkAvailable]);
  useLayoutEffect(() => { if (!drag.current.active) syncThumb(); }, [top, bottom, syncThumb]);
  useLayoutEffect(() => { if (dragging) placeBubble(); }, [label, dragging, placeBubble]);

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const markInput = () => { userInputUntil.current = performance.now() + USER_INPUT_MS; };
    const onScroll = () => {
      if (drag.current.active || performance.now() < ignoreScrollUntil.current) return;
      if (!checkAvailable()) return;
      syncThumb();
      // Programmatic scrolls (following a reply, restoring a position) leave
      // a hidden handle hidden.
      if (shownRef.current || performance.now() < userInputUntil.current) { show(); scheduleHide(); }
    };
    sc.addEventListener('touchstart', markInput, { passive: true });
    sc.addEventListener('touchmove', markInput, { passive: true });
    sc.addEventListener('wheel', markInput, { passive: true });
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      sc.removeEventListener('touchstart', markInput);
      sc.removeEventListener('touchmove', markInput);
      sc.removeEventListener('wheel', markInput);
      sc.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef, checkAvailable, syncThumb, show, scheduleHide]);

  useEffect(() => {
    const sc = scrollRef.current;
    return () => {
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(targetTimer.current);
      targetRef.current?.removeAttribute('data-scrub-target');
      sc?.removeAttribute('data-scrubber');
    };
  }, [scrollRef]);

  // The rendered user messages, top to bottom.
  const collect = useCallback((): Question[] => {
    const sc = scrollRef.current;
    if (!sc) return [];
    const out: Question[] = [];
    sc.querySelectorAll<HTMLElement>('[data-msg-id]').forEach((el) => {
      const message = usersRef.current.get(el.dataset.msgId ?? '');
      if (message) out.push({ el, message });
    });
    return out;
  }, [scrollRef]);

  const moveTo = useCallback((clientY: number) => {
    const sc = scrollRef.current, track = trackRef.current;
    if (!sc || !track) return;
    const d = drag.current;
    const fraction = fractionForThumb(clientY - d.trackTop - d.grab, track.clientHeight, GRIP);
    thumbY.current = thumbCenter(fraction, track.clientHeight, GRIP);
    placeThumb();
    ignoreScrollUntil.current = performance.now() + 150;
    sc.scrollTop = fraction * (sc.scrollHeight - sc.clientHeight);

    // A streamed reply can re-render the list mid-drag; read it again then.
    if (d.questions.some((q) => !q.el.isConnected)) d.questions = collect();
    const qs = d.questions;
    const scTop = sc.getBoundingClientRect().top;
    const i = lastAtOrAbove(qs.length, (k) => qs[k].el.getBoundingClientRect().top - scTop, sc.clientHeight * SCRUB_READING_LINE);
    if (i >= 0 && i !== d.index) {
      const dir = d.index < 0 ? undefined : i > d.index ? 'next' : 'prev';
      d.index = i;
      setTarget(qs[i].el);
      const m = qs[i].message;
      setLabel({ index: i + 1, total: qs.length, text: scrubLabelText(m), time: formatMessageTime(m.createdAt), dir });
    }
    placeBubble();
  }, [scrollRef, collect, placeThumb, placeBubble, setTarget]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (e.button > 0 || !track || !shownRef.current || !availableRef.current) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const d = drag.current;
    d.trackTop = track.getBoundingClientRect().top;
    const y = e.clientY - d.trackTop;
    // Keep the grab point under the finger, so touching the handle moves nothing.
    d.grab = Math.abs(y - thumbY.current) <= GRIP ? y - thumbY.current : 0;
    d.active = true;
    d.index = -1;
    d.questions = collect();
    window.clearTimeout(targetTimer.current);
    show();
    setDragging(true);
    onScrubRef.current('start');
    moveTo(e.clientY);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) return;
    onScrubRef.current('move');
    moveTo(e.clientY);
  };
  const end = () => {
    const d = drag.current;
    if (!d.active) return;
    d.active = false;
    d.questions = [];
    setDragging(false);
    scheduleHide();
    targetTimer.current = window.setTimeout(() => setTarget(null), TARGET_LINGER_MS);
  };

  return (
    <div ref={trackRef} className="transcript-scrubber" style={{ top, bottom }} aria-hidden="true">
      <div ref={bubbleRef} className="transcript-scrubber__bubble" data-shown={dragging && label ? '' : undefined}>
        {label && (
          <>
            <div className="transcript-scrubber__meta">
              <span><b>{label.index}</b> / {label.total}{hasOlder ? '+' : ''}</span>
              {label.time && <span>{label.time}</span>}
            </div>
            <div key={label.index} className="transcript-scrubber__text" data-dir={label.dir}>{label.text}</div>
          </>
        )}
      </div>
      <div
        ref={handleRef}
        className="transcript-scrubber__handle"
        data-shown={available && shown ? '' : undefined}
        data-dragging={dragging ? '' : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
      >
        <span className="transcript-scrubber__grip">
          <svg width="10" height="18" viewBox="0 0 10 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 6.5 5 3.5 8 6.5M2 11.5 5 14.5 8 11.5" />
          </svg>
        </span>
      </div>
    </div>
  );
}
