import React from 'react';
import { motion, type Transition } from 'motion/react';
import { DUR, EASE } from '../../motion/tokens';
import { usePhoneLayout } from '../../hooks/usePhoneLayout';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useBackLayer } from '../../lib/backStack';
import { isImeComposing } from '../../lib/ime';
import ResizeHandle from '../ResizeHandle';
import './DrawerShell.css';
import { useOverlayFocus } from './useOverlayFocus';
import './OverlaySurface.css';

const EXIT_TIMEOUT_MS = 220;
/** Narrowest a dragged drawer gets. */
const DRAWER_MIN_WIDTH = 320;
/** Widest a dragged drawer gets, as a share of the window; DrawerShell.css caps it the same. */
const DRAWER_MAX_VIEWPORT_SHARE = 0.75;

/** A drawer's dragged width and where it is kept (e.g. usePanelWidth). */
interface DrawerResize {
  /** The dragged width; undefined shows the drawer's `width`. */
  width: number | undefined;
  set: (width: number) => void;
  /** Back to the drawer's `width` (double-click on the edge). */
  reset: () => void;
}

// The scrim fades in like the shared .ui-scrim (fadeIn at --t-enter) and out
// a little faster, inside the panel's slide.
const SCRIM_IN: Transition = { duration: DUR.enter, ease: 'easeOut' };
const SCRIM_OUT: Transition = { duration: DUR.scrimExit, ease: EASE.out };

/** Shared right-anchored drawer. Presence includes the retiring panel. */
export interface DrawerShellProps {
  open: boolean;
  onClose: () => void;
  /** Set while the drawer shows a level inside it: Back (the phone's back
   *  swipe, the system Back) steps back one level instead of closing it,
   *  and the swipe shows the edge arrow rather than dragging the panel. */
  onBack?: () => void;
  motion?: 'standard' | 'instant';
  onPresenceChange?: (present: boolean) => void;
  /** Uppercased in the header via CSS; pass plain text e.g. "Settings". */
  title: React.ReactNode;
  /** Right-aligned header controls (e.g. add / file buttons). */
  headerActions?: React.ReactNode;
  /** Optional count/badge shown right after the title. */
  titleBadge?: React.ReactNode;
  /** Handle Escape at the drawer level. Set false when a nested overlay (e.g. a
   *  lightbox) should consume Escape first. Default true. */
  closeOnEscape?: boolean;
  /** How the header offers onClose. 'close' (default) is the trailing ×.
   *  'back' puts a back chevron before the title instead. A phone, where the
   *  drawer fills the screen and reads as a page, always shows 'back'. */
  closeControl?: 'close' | 'back';
  /** Override the default CSS width (440px). Applied as an inline style. */
  width?: number;
  /** Makes the drawer's left edge draggable on desktop (a phone's drawer
   *  fills the screen). Null or absent keeps the width fixed. */
  resize?: DrawerResize | null;
  /** Default true. False keeps the page usable beside the drawer: no scrim,
   *  no outside-click close, no aria-modal (still a labelled dialog that takes
   *  focus on open and gives it back on close). */
  modal?: boolean;
  'aria-label'?: string;
  children: React.ReactNode;
}

export function DrawerShell({
  open,
  onClose,
  onBack,
  motion: motionMode = 'standard',
  onPresenceChange,
  title,
  headerActions,
  titleBadge,
  closeOnEscape = true,
  closeControl: requestedCloseControl = 'close',
  width,
  resize: requestedResize,
  modal = true,
  children,
  ...rest
}: DrawerShellProps) {
  const ariaLabel = rest['aria-label'];
  const panelRef = React.useRef<HTMLDivElement>(null);
  useOverlayFocus({ open, panelRef, trap: modal, initialFocus: 'panel', trackOutsideFocus: !modal });
  const reducedMotion = useReducedMotion();
  const instant = motionMode === 'instant' || reducedMotion;
  const [retained, setRetained] = React.useState(open);
  const present = open || (!instant && retained);

  React.useLayoutEffect(() => {
    onPresenceChange?.(present);
    return () => onPresenceChange?.(false);
  }, [present, onPresenceChange]);

  React.useEffect(() => {
    if (open) {
      if (!retained) setRetained(true);
      return;
    }
    if (!retained) return;
    if (instant) {
      setRetained(false);
      return;
    }
    // transitionend is not guaranteed for hidden windows or interrupted CSS.
    const timer = window.setTimeout(() => setRetained(false), EXIT_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [open, instant, retained]);

  React.useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isImeComposing(e)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, closeOnEscape]);

  // A phone shows the drawer as a page over the app: its header goes back,
  // and so does Back, dragging the panel off to the right. Its body text
  // reads a step larger (data-phone; the sizes are in mobile.css).
  const phone = usePhoneLayout();
  const closeControl = phone ? 'back' : requestedCloseControl;
  const resize = phone ? null : requestedResize ?? null;
  const shownWidth = resize?.width ?? width;
  useBackLayer(open, {
    back: onBack ?? onClose,
    swipe: onBack ? undefined : { panel: () => panelRef.current, exit: 'owner' },
  });

  if (!present) return null;

  return (
    <>
      {modal && (
        <motion.div
          className="ui-scrim ui-scrim--drawer drawer-shell-scrim"
          data-state={open ? 'open' : 'closed'}
          onMouseDown={open ? onClose : undefined}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          initial={{ opacity: 0 }}
          animate={open ? { opacity: 1, transition: SCRIM_IN } : { opacity: 0, transition: SCRIM_OUT }}
        />
      )}
      <div
        ref={panelRef}
        className="ui-drawer-panel ui-overlay-surface term-glass drawer-shell-panel"
        data-glass="solid"
        data-state={open ? 'open' : 'closed'}
        data-motion={instant ? 'instant' : 'standard'}
        data-phone={phone || undefined}
        tabIndex={-1}
        inert={!open}
        role="dialog"
        aria-modal={modal || undefined}
        aria-hidden={!open || undefined}
        aria-label={typeof title === 'string' ? title : ariaLabel}
        data-resizable={resize ? 'true' : undefined}
        style={shownWidth ? { width: shownWidth } : undefined}
        onTransitionEnd={(event) => {
          if (!open && event.target === event.currentTarget && event.propertyName === 'transform') {
            setRetained(false);
          }
        }}
      >
        <div className="ui-overlay-header">
          {closeControl === 'back' && (
            <button
              type="button"
              className="ui-overlay-close drawer-shell-back"
              onClick={onClose}
              title="Back (esc)"
              aria-label="Back"
            >
              <svg width={18} height={18} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 3L5 8l5 5" />
              </svg>
            </button>
          )}
          <span className="ui-overlay-title">{closeControl === 'back' ? title : <>▸ {title}</>}</span>
          {titleBadge}
          <span style={{ flex: 1 }} />
          {headerActions}
          {closeControl === 'close' && (
            <button
              type="button"
              className="ui-overlay-close"
              onClick={onClose}
              title="Close (esc)"
              aria-label="Close"
            >
              ×
            </button>
          )}
        </div>
        {children}
        {resize && open && (
          <ResizeHandle
            paneRef={panelRef}
            side="left"
            min={DRAWER_MIN_WIDTH}
            onResize={(w) => resize.set(Math.min(w, Math.round(window.innerWidth * DRAWER_MAX_VIEWPORT_SHARE)))}
            onReset={resize.reset}
          />
        )}
      </div>
    </>
  );
}
