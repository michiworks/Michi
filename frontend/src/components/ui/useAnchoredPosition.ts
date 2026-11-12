import React from 'react';

/**
 * Where a panel hung from an anchor goes: `gap` under it, or above it when
 * the viewport runs out below and there is room above; `pad` inside the
 * viewport's sides. `align` lines up the left edges (start, `lead` further
 * left) or the right edges (end).
 */
export function placeBelowAnchor(
  rect: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  { align = 'start', lead = 0, gap, pad = 8 }: { align?: 'start' | 'end'; lead?: number; gap: number; pad?: number },
): { left: number; top: number } {
  const wanted = align === 'end' ? rect.right - size.width : rect.left - lead;
  const left = Math.max(pad, Math.min(window.innerWidth - size.width - pad, wanted));
  let top = rect.bottom + gap;
  if (top + size.height > window.innerHeight - pad && rect.top - gap - size.height >= pad) top = rect.top - gap - size.height;
  return { left, top };
}

/**
 * The side of its trigger a menu opens on, given the room on each side and
 * the height it wants: the preferred side (above, or below with
 * `preferBelow`) when all of it fits there, else the other when it fits
 * there, else the roomier side.
 */
export function pickMenuSide({ aboveSpace, belowSpace, wanted, preferBelow = false }: {
  aboveSpace: number;
  belowSpace: number;
  wanted: number;
  preferBelow?: boolean;
}): 'above' | 'below' {
  const above = preferBelow
    ? belowSpace < wanted && aboveSpace > belowSpace
    : aboveSpace >= wanted || (belowSpace < wanted && aboveSpace > belowSpace);
  return above ? 'above' : 'below';
}

/** Keep a fixed, portaled surface attached while its viewport or measured size changes. */
export function useAnchoredPosition({ anchor, surfaceRef, measure, dependencies = [] }: {
  anchor: HTMLElement | null;
  surfaceRef: React.RefObject<HTMLElement | null>;
  measure: () => void;
  dependencies?: React.DependencyList;
}) {
  const measureRef = React.useRef(measure);
  measureRef.current = measure;
  React.useLayoutEffect(() => {
    const update = () => measureRef.current();
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (anchor) observer?.observe(anchor);
    if (surfaceRef.current) observer?.observe(surfaceRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
    // Consumer dependencies describe the geometry; callbacks stay fresh by ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, surfaceRef, ...dependencies]);
}
