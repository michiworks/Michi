import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import AskUserNotice from './AskUserNotice';
import InterruptedTurnsNotice from './InterruptedTurnsNotice';
import { NoticeAnnounceContext } from './shellNoticeParts';

/** How far below the stack toasts start (index.css reads --shell-notices-height). */
const TOAST_GAP_PX = 8;

interface Box { left: number; top: number; right: number; bottom: number }

function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Where the stack's notices sit at rest, from layout offsets: the transforms
 * of a notice sliding or of the stack stepping aside do not move them.
 */
function noticeBoxes(stack: HTMLElement): Box[] {
  const anchor = (stack.offsetParent ?? stack.parentElement)?.getBoundingClientRect();
  if (!anchor) return [];
  const left = anchor.left + stack.offsetLeft;
  const top = anchor.top + stack.offsetTop;
  return [...stack.children].filter((child): child is HTMLElement => child instanceof HTMLElement).map((child) => ({
    left: left + child.offsetLeft,
    top: top + child.offsetTop,
    right: left + child.offsetLeft + child.offsetWidth,
    bottom: top + child.offsetTop + child.offsetHeight,
  }));
}

/**
 * The corner where Michi keeps what waits on the user: an agent's question
 * (AskUserNotice) and tasks that stopped before finishing (InterruptedTurnsNotice).
 * Pinned under the topbar's right end, where toasts appear, but unlike a
 * toast a notice stays until its state resolves: the question is answered,
 * the task resumed or dismissed. Each can be shrunk to a tab; something new
 * opens it again. Toasts start below the stack.
 *
 * While the user works in something the corner would cover (a region marked
 * `data-notice-avoid`: a composer, the pane find bar), the corner steps aside
 * off the edge, and comes back once focus leaves it. News is read out once,
 * politely, by one live region.
 */
export default function ShellNotices() {
  const stack = useRef<HTMLDivElement>(null);
  const [aside, setAside] = useState(false);
  const [message, setMessage] = useState('');

  useLayoutEffect(() => {
    const node = stack.current;
    const root = document.documentElement;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const publish = () => {
      const height = aside ? 0 : node.getBoundingClientRect().height;
      root.style.setProperty('--shell-notices-height', `${height > 0 ? Math.ceil(height) + TOAST_GAP_PX : 0}px`);
    };
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    publish();
    return () => {
      observer.disconnect();
      root.style.removeProperty('--shell-notices-height');
    };
  }, [aside]);

  useEffect(() => {
    let frame = 0;
    const check = () => {
      const node = stack.current;
      const active = document.activeElement;
      const region = node && active instanceof HTMLElement && !node.contains(active)
        ? active.closest<HTMLElement>('[data-notice-avoid]')
        : null;
      const covered = region ? region.getBoundingClientRect() : null;
      setAside(!!covered && noticeBoxes(node!).some((box) => boxesOverlap(box, covered)));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(check);
    };
    document.addEventListener('focusin', schedule);
    document.addEventListener('focusout', schedule);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('focusin', schedule);
      document.removeEventListener('focusout', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  // Cleared first, so the same words said again are read again.
  const announce = useCallback((text: string) => {
    setMessage('');
    requestAnimationFrame(() => setMessage(text));
  }, []);

  return (
    <div className="shell-notices-anchor">
      <div ref={stack} className="shell-notices" data-aside={aside || undefined} inert={aside}>
        <NoticeAnnounceContext.Provider value={announce}>
          <AskUserNotice />
          <InterruptedTurnsNotice />
        </NoticeAnnounceContext.Provider>
      </div>
      <div className="sr-only" role="status" aria-live="polite">{message}</div>
    </div>
  );
}
