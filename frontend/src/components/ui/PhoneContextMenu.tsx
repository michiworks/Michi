import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from 'motion/react';
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  AtSign,
  Combine,
  Copy,
  Download,
  Eye,
  EyeOff,
  FilePlus,
  FileText,
  FolderInput,
  FolderOpen,
  GitBranch,
  GitMerge,
  History,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Pin,
  PinOff,
  Scissors,
  SquareArrowOutUpRight,
  SquareCheck,
  SquareX,
  Star,
  StarOff,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { MenuItem, MenuSection } from '../ContextMenu';
import { isLongPressHolding, onLongPressHold, releasePressFeedback } from '../../lib/touchContextMenu';
import { useBackLayer } from '../../lib/backStack';
import { isImeComposing } from '../../lib/ime';
import { prefersReducedMotion } from '../../hooks/useReducedMotion';
import './PhoneContextMenu.css';

/*
 * The phone's right-click menu. The element it belongs to lifts out of a
 * blurred page in its own shape (a square full-width row stays square and
 * flush, a pill stays a pill: iOS's targeted preview with the element's own
 * visible path), and the menu springs out beside it. When neither side has
 * room the lifted element moves up to make it. A finger still down from the
 * long press can slide onto an item and lift to choose it.
 *
 * While the menu is up the element itself is hidden and a copy carrying its
 * computed styles stands in for it, as UIKit hides the source view behind a
 * targeted preview; the copy settles back onto it when the menu is dismissed.
 */

interface PhoneContextMenuProps {
  /** The element the menu belongs to; null opens a plain menu at (x, y). */
  anchor: HTMLElement | null;
  x: number;
  y: number;
  sections: MenuSection[];
  onClose: () => void;
}

const GAP = 8;
const EDGE = 10;
/** Narrower than this share of the screen, an element grows a little as it lifts. */
const WIDE_SHARE = 0.62;
const SMALL_GROWTH = 1.03;
/** How far a held finger must travel before lifting it chooses an item. */
const SLIDE_MIN = 12;
const SPRING = 'cubic-bezier(.22, 1.18, .36, 1)';
const SETTLE = 'cubic-bezier(.32, .72, 0, 1)';
const LIFT_MS = 440;
const SETTLE_MS = 270;

/** Icons by the menus' stable ids, else by their (product-copy) labels. */
const ICON_BY_ID: Record<string, LucideIcon> = {
  manage: ArrowUpRight,
  folder: FolderOpen,
  'open-folder': FolderOpen,
  rename: Pencil,
  edit: Pencil,
  runs: History,
  pin: Pin,
  unpin: PinOff,
  archive: Archive,
  'archive-nodes': Archive,
  unarchive: ArchiveRestore,
  delete: Trash2,
  export: Download,
  open: SquareArrowOutUpRight,
  branch: GitBranch,
  'extract-tree': GitMerge,
  select: SquareCheck,
  trim: Scissors,
  weave: Combine,
  digest: FileText,
  clear: X,
  close: X,
  'close-others': SquareX,
  duplicate: Copy,
  hide: EyeOff,
  show: Eye,
  download: Download,
  cite: AtSign,
  goto: MessageSquare,
  favorite: Star,
  unfavorite: StarOff,
};
const ICON_BY_LABEL: Array<[RegExp, LucideIcon]> = [
  [/^Rename/, Pencil],
  [/^Pause\b/, Pause],
  [/^Resume\b/, Play],
  [/^Unpin\b/, PinOff],
  [/^Pin\b/, Pin],
  [/^Unarchive\b/, ArchiveRestore],
  [/^Archive\b/, Archive],
  [/^Export\b/, Download],
  [/^Move to (trash|Trash)|^Move page to trash/, Trash2],
  [/^Move\b/, FolderInput],
  [/^Delete\b/, Trash2],
  [/^Clear selection/, X],
  [/^Add a page inside/, FilePlus],
  [/^Manage workspace/, ArrowUpRight],
  [/^(Change|Link) folder/, FolderOpen],
];

function phoneMenuIcon(item: MenuItem): LucideIcon | null {
  return ICON_BY_ID[item.id] ?? ICON_BY_LABEL.find(([pattern]) => pattern.test(item.label))?.[1] ?? null;
}

interface Box { x: number; y: number; w: number; h: number; r: number }
interface Lift { anchor: HTMLElement; wrap: HTMLDivElement; copy: HTMLElement; to: Box; back: Box; toScale: number; backScale: number; shadow: string }

const half = (value: number) => Math.round(value * 2) / 2;
const boxFrames = (b: Box, shadow: string): Keyframe => ({
  left: `${half(b.x)}px`, top: `${half(b.y)}px`, width: `${b.w}px`, height: `${b.h}px`, borderRadius: `${b.r}px`, boxShadow: shadow,
});
const NO_SHADOW = '0 0 0 0 rgba(0, 0, 0, 0)';
const LIFT_SHADOW = '0 12px 28px -8px rgba(0, 0, 0, .3), var(--term-float-shadow)';

const canAnimate = (el: Element) => typeof el.animate === 'function' && !prefersReducedMotion();

function alphaOf(color: string): number {
  if (!color || color === 'transparent') return 0;
  if (color.startsWith('color(')) return color.includes('/') ? parseFloat(color.split('/')[1]) : 1;
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (!match) return 1;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
  return parts.length > 3 ? parts[3] : 1;
}

/** The opaque colour under an element; a translucent layer (the glass drawer) gives the surface. */
function liftBackground(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor;
    const alpha = alphaOf(color);
    if (alpha >= 0.95) return color;
    if (alpha > 0.02 && node !== el) break;
  }
  return 'var(--term-surface)';
}

/** Properties a still copy must not carry over. */
const SKIPPED = /^(transition|animation|visibility|scale|translate|rotate|will-change|pointer-events|cursor|view-transition|content-visibility|container)/;

function copyComputedStyles(from: Element, to: Element): void {
  const computed = getComputedStyle(from);
  const style = (to as HTMLElement).style;
  if (!style) return;
  for (let i = 0; i < computed.length; i++) {
    const property = computed[i];
    if (SKIPPED.test(property)) continue;
    style.setProperty(property, computed.getPropertyValue(property));
  }
  const fromChildren = from.children;
  const toChildren = to.children;
  for (let i = 0; i < fromChildren.length && i < toChildren.length; i++) copyComputedStyles(fromChildren[i], toChildren[i]);
}

/** A still copy of an element that looks the same anywhere in the page. */
function snapshot(el: HTMLElement): HTMLElement {
  const copy = el.cloneNode(true) as HTMLElement;
  copyComputedStyles(el, copy);
  for (const node of [copy, ...Array.from(copy.querySelectorAll('*'))]) {
    node.removeAttribute('id');
    node.removeAttribute('data-testid');
    node.removeAttribute('data-context-target');
    node.removeAttribute('data-press');
  }
  copy.setAttribute('aria-hidden', 'true');
  copy.setAttribute('inert', '');
  return copy;
}

/** Below the element, else above it, else (as iOS does) move the element up so both fit. */
function placeMenu(
  view: { w: number; top: number; floor: number },
  prev: Box,
  menu: { w: number; h: number },
  px: number,
): { prevY: number; menuX: number; menuY: number; origin: string } {
  let prevY = prev.y;
  let menuY: number;
  let below = true;
  if (prevY + prev.h + GAP + menu.h <= view.floor) menuY = prevY + prev.h + GAP;
  else if (prevY - GAP - menu.h >= view.top) {
    menuY = prevY - GAP - menu.h;
    below = false;
  } else {
    menuY = Math.max(view.top + prev.h + GAP, view.floor - menu.h);
    prevY = Math.max(view.top, menuY - GAP - prev.h);
  }
  const wide = prev.w > view.w * WIDE_SHARE;
  const leftSide = px < view.w / 2;
  let menuX = wide ? (leftSide ? prev.x + 4 : prev.x + prev.w - menu.w - 4) : prev.x + prev.w / 2 - menu.w / 2;
  menuX = Math.max(EDGE, Math.min(view.w - menu.w - EDGE, menuX));
  return { prevY, menuX, menuY, origin: `${wide ? (leftSide ? 'left' : 'right') : 'center'} ${below ? 'top' : 'bottom'}` };
}

export function PhoneContextMenu({ anchor, x, y, sections, onClose }: PhoneContextMenuProps) {
  const [isPresent, safeToRemove] = usePresence();
  const layerRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef<Lift | null>(null);
  const closingRef = useRef(false);
  const pressedScrim = useRef(false);
  const [hot, setHot] = useState<string | null>(null);
  const hotRef = useRef<string | null>(null);
  hotRef.current = hot;
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const sectionsRef = useRef(sections);
  useLayoutEffect(() => { sectionsRef.current = sections; }, [sections]);

  const restoreAnchor = useCallback(() => {
    const lift = liftRef.current;
    if (!lift) return;
    lift.anchor.style.visibility = '';
    lift.wrap.remove();
    liftRef.current = null;
  }, []);

  // Lift the element and place the menu, once, before the first paint.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const layer = layerRef.current;
    if (!menu || !layer) return;
    const probe = probeRef.current ? getComputedStyle(probeRef.current) : null;
    const view = {
      w: window.innerWidth,
      top: (parseFloat(probe?.paddingTop ?? '') || 0) + GAP,
      floor: window.innerHeight - (parseFloat(probe?.paddingBottom ?? '') || 0) - GAP,
    };
    const size = { w: menu.offsetWidth, h: menu.offsetHeight };
    let place: { menuX: number; menuY: number; origin: string };
    const visible = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    // Nothing to lift when the element has no box (gone, or display: contents).
    if (anchor && visible && visible.width > 0 && visible.height > 0) {
      const pressed = parseFloat(getComputedStyle(anchor).scale) || 1;
      const unit = anchor.offsetWidth || visible.width;
      const base: Box = { w: visible.width / pressed, h: visible.height / pressed, x: 0, y: 0, r: 0 };
      base.x = visible.left + visible.width / 2 - base.w / 2;
      base.y = visible.top + visible.height / 2 - base.h / 2;
      // A zoomed camera (the map) scales the element; its copy keeps the zoom.
      const zoom = base.w / unit;
      base.r = (parseFloat(getComputedStyle(anchor).borderTopLeftRadius) || 0) * zoom;
      // Read the element without a fill still fading or the press-in still applied.
      const inlineTransition = anchor.style.transition;
      anchor.style.transition = 'none';
      releasePressFeedback(anchor);
      void anchor.offsetWidth;
      const copy = snapshot(anchor);
      const background = liftBackground(anchor);
      anchor.style.transition = inlineTransition;

      const width = base.w < view.w * WIDE_SHARE ? base.w * SMALL_GROWTH : base.w;
      const toScale = zoom * (width / base.w);
      const height = (anchor.offsetHeight || base.h / zoom) * toScale;
      const prev: Box = { x: base.x + base.w / 2 - width / 2, y: base.y + base.h / 2 - height / 2, w: width, h: height, r: base.r * (width / base.w) };
      const placed = placeMenu(view, prev, size, x);
      const to: Box = { ...prev, y: placed.prevY };
      const from: Box = { x: visible.left, y: visible.top, w: visible.width, h: visible.height, r: base.r };

      const wrap = document.createElement('div');
      wrap.className = 'phone-menu-lift';
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.background = background;
      // Not !important: the lift animation drives these, and an important
      // declaration would outrank it.
      copy.style.width = `${unit}px`;
      copy.style.height = `${anchor.offsetHeight}px`;
      copy.style.transformOrigin = '0 0';
      copy.style.transform = `scale(${toScale})`;
      wrap.append(copy);
      Object.assign(wrap.style, boxFrames(to, LIFT_SHADOW));
      layer.insertBefore(wrap, menu);
      anchor.style.visibility = 'hidden';
      liftRef.current = { anchor, wrap, copy, to, back: base, toScale, backScale: zoom, shadow: LIFT_SHADOW };
      if (canAnimate(wrap)) {
        wrap.animate([boxFrames(from, NO_SHADOW), boxFrames(to, LIFT_SHADOW)], { duration: LIFT_MS, easing: SPRING });
        copy.animate([{ transform: `scale(${visible.width / unit})` }, { transform: `scale(${toScale})` }], { duration: LIFT_MS, easing: SPRING });
      }
      place = placed;
    } else {
      place = {
        menuX: Math.max(EDGE, Math.min(view.w - size.w - EDGE, x)),
        menuY: Math.max(view.top, Math.min(view.floor - size.h, y)),
        origin: 'left top',
      };
    }
    menu.style.left = `${place.menuX}px`;
    menu.style.top = `${place.menuY}px`;
    menu.style.maxHeight = `${Math.max(120, view.floor - Math.max(view.top, place.menuY))}px`;
    menu.style.transformOrigin = place.origin;
    menu.style.visibility = '';
    if (canAnimate(menu)) {
      menu.animate([{ opacity: 0, transform: 'scale(.45)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 360, delay: 60, easing: SPRING, fill: 'backwards' });
      scrimRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
    }
    // The element always comes back, however the menu goes away (and the
    // copy goes with it, or StrictMode's second pass would lift a second one).
    return restoreAnchor;
    // Placed once, at the press; the menu does not chase later layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Fold the menu back and settle the copy onto the element, then call `done`. */
  const animateOut = useCallback((done: () => void) => {
    const menu = menuRef.current;
    const lift = liftRef.current;
    const scrim = scrimRef.current;
    if (!menu || !canAnimate(menu)) { restoreAnchor(); done(); return; }
    menu.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.82)' }], { duration: 150, easing: 'ease-in', fill: 'forwards' });
    scrim?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out', fill: 'forwards' });
    if (lift) {
      // Back to where the element is now: the list under the menu may have scrolled.
      const now = lift.anchor.isConnected ? lift.anchor.getBoundingClientRect() : null;
      const back = now && now.width > 0 ? { ...lift.back, x: now.left, y: now.top, w: now.width, h: now.height } : lift.back;
      lift.wrap.animate([boxFrames(lift.to, lift.shadow), boxFrames(back, NO_SHADOW)], { duration: SETTLE_MS, easing: SETTLE, fill: 'forwards' });
      lift.copy.animate([{ transform: `scale(${lift.toScale})` }, { transform: `scale(${lift.backScale})` }], { duration: SETTLE_MS, easing: SETTLE, fill: 'forwards' });
    }
    window.setTimeout(() => { restoreAnchor(); done(); }, lift ? SETTLE_MS + 10 : 200);
  }, [restoreAnchor]);

  const dismiss = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    animateOut(() => onCloseRef.current());
  }, [animateOut]);
  useBackLayer(isPresent, { back: dismiss });

  // An item runs in the same tap (or finger lift) that chose it, so a rename
  // field it opens can raise the keyboard on iOS. The element is shown again
  // first: a hidden field cannot take focus.
  const choose = useCallback((item: MenuItem) => {
    if (closingRef.current || item.disabled) return;
    const current = sectionsRef.current.flatMap((section) => section.items).find((candidate) => candidate.id === item.id);
    if (!current || current.disabled) return;
    closingRef.current = true;
    restoreAnchor();
    current.run();
    onCloseRef.current();
  }, [restoreAnchor]);

  // Reopened during the fade-out (a same-key child revived by AnimatePresence):
  // a menu still closing would ignore every tap behind its faded-out layer.
  const wasPresent = useRef(isPresent);
  useLayoutEffect(() => {
    if (isPresent && !wasPresent.current) {
      closingRef.current = false;
      for (const el of [menuRef.current, scrimRef.current]) el?.getAnimations?.().forEach((animation) => animation.cancel());
    }
    wasPresent.current = isPresent;
  }, [isPresent]);

  // Closed from outside (the caller's AnimatePresence): settle, then leave.
  useEffect(() => {
    if (isPresent) return;
    if (closingRef.current) {
      const menu = menuRef.current;
      if (menu && canAnimate(menu)) {
        menu.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: 'ease-in', fill: 'forwards' });
        scrimRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out', fill: 'forwards' });
        const timer = window.setTimeout(() => safeToRemove?.(), 170);
        return () => window.clearTimeout(timer);
      }
      safeToRemove?.();
      return;
    }
    closingRef.current = true;
    animateOut(() => safeToRemove?.());
  }, [isPresent, safeToRemove, animateOut]);

  // A finger still down from the long press slides onto an item; lifting chooses it.
  useEffect(() => {
    if (!isLongPressHolding()) return;
    return onLongPressHold((event, phase) => {
      const item = (document.elementFromPoint?.(event.clientX, event.clientY) as Element | null)
        ?.closest<HTMLElement>('[data-phone-menu-item]');
      const id = item && !(item as HTMLButtonElement).disabled ? item.dataset.phoneMenuItem ?? null : null;
      if (phase === 'move') { if (id !== hotRef.current) setHot(id); return; }
      setHot(null);
      if (!id || Math.hypot(event.clientX - x, event.clientY - y) < SLIDE_MIN) return;
      const chosen = sectionsRef.current.flatMap((section) => section.items).find((candidate) => candidate.id === id);
      if (chosen) choose(chosen);
    });
  }, [x, y, choose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeComposing(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dismiss();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [dismiss]);

  const visible = sections.filter((section) => section.items.length > 0);
  return createPortal(
    <div ref={layerRef} className="phone-menu-layer" data-phone-menu="" style={{ pointerEvents: isPresent ? undefined : 'none' }}>
      <div ref={probeRef} className="phone-menu-probe" aria-hidden="true" />
      <div
        ref={scrimRef}
        className="phone-menu-scrim"
        aria-hidden="true"
        // The long press that opened the menu lifts its finger over the scrim;
        // only a tap that also started here closes it.
        onPointerDown={() => { pressedScrim.current = true; }}
        onClick={() => { const pressed = pressedScrim.current; pressedScrim.current = false; if (pressed) dismiss(); }}
        onContextMenu={(event) => event.preventDefault()}
      />
      <div ref={menuRef} className="phone-menu" role="menu" aria-label="Actions" style={{ visibility: 'hidden' }} onContextMenu={(event) => event.preventDefault()}>
        {visible.map((section, index) => (
          <React.Fragment key={index}>
            {index > 0 && <div className="phone-menu__sep" aria-hidden="true" />}
            {section.label && <div className="phone-menu__label" aria-hidden="true">{section.label}</div>}
            {section.items.map((item) => {
              const Icon = phoneMenuIcon(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  className="phone-menu__item"
                  data-phone-menu-item={item.id}
                  data-hot={hot === item.id || undefined}
                  data-danger={item.danger || undefined}
                  disabled={item.disabled}
                  onClick={() => choose(item)}
                >
                  {Icon && <Icon size={18} strokeWidth={1.7} aria-hidden="true" />}
                  <span className="phone-menu__text">
                    <span>{item.label}</span>
                    {item.sublabel && <span className="phone-menu__sub">{item.sublabel}</span>}
                  </span>
                  {item.glyph && <span className="phone-menu__glyph" aria-hidden="true">{item.glyph}</span>}
                </button>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
}
