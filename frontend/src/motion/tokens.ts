import type { Transition } from 'motion/react';

/**
 * Motion tokens for `motion` (motion.dev): the JS mirror of the CSS duration
 * tokens in index.css (`--t-*`) and the shared curves already used by
 * DrawerShell, paneMotion and branchMotion. Durations are in seconds.
 * tokens.css.test.js keeps them in step with index.css.
 *
 * Loops (shimmer, spinners, breathing dots, carets) stay in CSS; these are for
 * enter/exit, layout and disclosure transitions.
 */
export const DUR = {
  // Mirrors --t-quick … --t-slow and --t-exit.
  quick: 0.06,
  soft: 0.1,
  enter: 0.18,
  /** Exits run a little faster than their entrances. */
  exit: 0.11,
  decay: 0.36,
  slow: 0.6,
  // motion only (no CSS counterpart).
  /** Disclosure bodies: "collapse fast, expand soft". */
  expand: 0.26,
  collapse: 0.16,
  /** A scrim clears just before the panel it dims has finished collapsing. */
  scrimExit: 0.14,
} as const;

type Bezier = [number, number, number, number];

export const EASE: Record<'out' | 'drawer' | 'inOut' | 'term', Bezier> = {
  /** DrawerShell's slide; the default for entrances. */
  out: [0.23, 1, 0.32, 1],
  /** = PANE_EASE: panels, disclosures, layout settles. */
  drawer: [0.32, 0.72, 0, 1],
  /** = branchMotion's flight: things travelling across the screen. */
  inOut: [0.77, 0, 0.175, 1],
  /** = --t-ease. */
  term: [0.2, 0, 0.6, 1],
};

export const SPRING = {
  /** Small things settling with no overshoot: icons, bubbles, chips. */
  snappy: { type: 'spring', visualDuration: 0.22, bounce: 0 },
  /** Shared-element flights (layoutId) and layout moves. */
  soft: { type: 'spring', visualDuration: 0.3, bounce: 0.12 },
  /** Rare, high-emotion moments only (task done, first run). */
  pop: { type: 'spring', visualDuration: 0.4, bounce: 0.3 },
} as const satisfies Record<string, Transition>;

/**
 * The on-screen keyboard's own move, approximately: iOS lowers it in about
 * 350ms, fast at first with a long settle, and Safari carries the page down
 * with it. What a phone send moves while the keyboard goes down (the thread's
 * rise, the composer's rest) rides this curve, so the screen moves one way at
 * once instead of the thread rising while the page falls.
 */
export const KEYBOARD_MOVE: { duration: number; ease: Bezier } = { duration: 0.35, ease: [0.38, 0.7, 0.125, 1] };

/**
 * The 'line' agent-block chrome (agentBlockMotion: LineSwap, LineGlyphSwap,
 * useLineDrawer, LineFlash). Seconds; `shift` is px. Under reduced motion the
 * same durations run opacity only, and the drawer only fades open.
 */
export const LINE_MOTION = {
  /** Lead label swap: the old label rises out, the new one rises in. */
  labelOut: 0.12,
  labelIn: 0.18,
  labelDelay: 0.04,
  shift: 3,
  /** The rest of the record dips: out in place, back once the lead settled. */
  restOut: 0.09,
  restIn: 0.17,
  restDelay: 0.15,
  /** Status glyph: opacity + scale .6 → 1. */
  glyphOut: 0.1,
  glyphIn: 0.18,
  glyphFrom: 0.6,
  /** Transform drawer: "expand soft, collapse fast". */
  drawerOpen: DUR.expand,
  drawerClose: 0.18,
  drawerFadeIn: 0.14,
  /** One danger tint, 12% → 0, when a failure arrives. */
  flash: 0.7,
  flashFrom: 0.12,
} as const;

/** Ready-made transitions for the common cases. */
export const TRANSITION = {
  enter: { duration: DUR.enter, ease: EASE.out },
  exit: { duration: DUR.exit, ease: EASE.out },
  expand: {
    height: { duration: DUR.expand, ease: EASE.drawer },
    opacity: { duration: 0.16, delay: 0.04, ease: 'linear' },
  },
  collapse: { duration: DUR.collapse, ease: EASE.drawer },
} as const satisfies Record<string, Transition>;
