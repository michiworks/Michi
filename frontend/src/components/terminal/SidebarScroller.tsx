import { useLayoutEffect, useRef } from 'react';

/** Air between the thumb and the list's top and bottom edges. */
const TRACK_PAD = 3;
const MIN_THUMB = 24;

/** Last scroll offset of each keyed list, for the life of the page. */
const savedScrollTop = new Map<string, number>();

/**
 * A sidebar list with its own scroll thumb instead of the native scrollbar.
 *
 * macOS overlay scrollbars float above the content and take no room, so
 * `scrollbar-gutter` cannot keep them off the rows: while scrolling, the thumb
 * covered the running rail every row draws at its right edge (right 2–5px).
 * This thumb is a 2px strip flush with the edge, beside the rail.
 *
 * It only shows the position. The sidebar's resize handle owns the rightmost
 * 8px and sits above the list, so the thumb is not draggable, as the native
 * bar under that handle was not. The list still scrolls by wheel, touch and
 * keyboard. Visibility follows the aside's `data-scrollbars` (Sidebar.tsx).
 *
 * With a `scrollKey` the list comes back where it was left: the phone drawer
 * unmounts on close, and switching lens remounts the list, so without it
 * every open started at the top and the reveal of the open conversation
 * (useSidebarTreeController) pinned that row to the bottom edge.
 */
export function SidebarScroller({ className, children, scrollKey, ...rest }: React.HTMLAttributes<HTMLDivElement> & {
  scrollKey?: string;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const view = viewRef.current;
    const thumb = thumbRef.current;
    if (!frame || !view || !thumb) return;

    // Before the first paint, and before the reveal two frames later, which
    // then scrolls only if the open conversation is out of view.
    const saved = scrollKey === undefined ? undefined : savedScrollTop.get(scrollKey);
    if (saved !== undefined) view.scrollTop = saved;

    let range = 0;
    let travel = 0;
    const place = () => {
      if (scrollKey !== undefined) savedScrollTop.set(scrollKey, view.scrollTop);
      if (range <= 0) return;
      const top = TRACK_PAD + travel * Math.min(1, Math.max(0, view.scrollTop / range));
      thumb.style.transform = `translateY(${top}px)`;
    };
    const measure = () => {
      range = view.scrollHeight - view.clientHeight;
      if (range <= 1) {
        range = 0;
        frame.removeAttribute('data-overflow');
        return;
      }
      const track = view.clientHeight - TRACK_PAD * 2;
      const size = Math.max(MIN_THUMB, Math.round((track * view.clientHeight) / view.scrollHeight));
      travel = track - size;
      thumb.style.height = `${size}px`;
      frame.setAttribute('data-overflow', '');
      place();
    };

    let frameId = 0;
    const scheduleMeasure = () => {
      if (frameId) return;
      frameId = requestAnimationFrame(() => { frameId = 0; measure(); });
    };
    // The list's own box and each top-level child: a group expanding or a
    // row arriving changes scrollHeight without resizing the list itself.
    const resize = new ResizeObserver(scheduleMeasure);
    const observeAll = () => {
      resize.disconnect();
      resize.observe(view);
      for (const child of view.children) resize.observe(child);
    };
    const children = new MutationObserver(() => { observeAll(); scheduleMeasure(); });
    observeAll();
    children.observe(view, { childList: true });
    view.addEventListener('scroll', place, { passive: true });
    measure();
    return () => {
      cancelAnimationFrame(frameId);
      resize.disconnect();
      children.disconnect();
      view.removeEventListener('scroll', place);
    };
  }, [scrollKey]);

  return (
    <div ref={frameRef} className="sb-scroller">
      <div ref={viewRef} className={['sb-scroller__view', className].filter(Boolean).join(' ')} {...rest}>
        {children}
      </div>
      <div ref={thumbRef} className="sb-scroller__thumb" aria-hidden />
    </div>
  );
}
