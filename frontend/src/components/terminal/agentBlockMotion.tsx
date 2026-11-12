import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, MotionGlobalConfig, PresenceContext, motion, useIsPresent, usePresenceData, useReducedMotionConfig, type TargetAndTransition, type Transition } from 'motion/react';
import { DUR, EASE, LINE_MOTION, SPRING } from '../../motion/tokens';

/**
 * Motion for the agent blocks: tool-call groups (ToolCallGroup and the
 * AgentBlockVariants chromes), subagent lines, agent-run and workflow cards.
 *
 * Only transitions animate. Whatever is there when its list, disclosure or
 * glyph slot mounts renders settled (`AnimatePresence initial={false}`, or the
 * key/visibility seen on the first render), so hydration, remounts and
 * re-expanding a finished group never replay an entrance.
 *
 * Tool updates arrive rAF-batched many times a second. Every target here is a
 * module constant keyed to a state (present, status kind, header mode), never
 * to streamed content, so re-rendering in the same state restarts nothing.
 * CSS loops (breathing dot, shimmer, spinner) stay on the inner elements;
 * motion drives only the wrappers around them.
 */

/* ── Height reveals ──────────────────────────────────────────────────── */

const HIDDEN = { height: 0, opacity: 0, overflow: 'hidden' } as const;

const COLLAPSE: TargetAndTransition = {
  ...HIDDEN,
  transition: {
    height: { duration: DUR.collapse, ease: EASE.drawer },
    opacity: { duration: DUR.soft, ease: 'linear' },
  },
};

function opened(height: number, ease: typeof EASE.out, opacity: { duration: number; delay: number }): TargetAndTransition {
  return {
    height: 'auto',
    opacity: 1,
    transition: { height: { duration: height, ease }, opacity: { ...opacity, ease: 'linear' } },
    // Clip only while moving: a settled body keeps its focus rings.
    transitionEnd: { overflow: 'visible' },
  };
}

/**
 * A click in the transcript records its height for two frames; a follow-mode
 * pin that finds it changed leaves follow mode instead of throwing the view to
 * the tail (TPane `userClickLayoutRef`). A tween's first frame samples t=0, so
 * a body opening from 0px or closing from its own height would first move a
 * frame too late. Bodies the user toggles therefore change height in the
 * click's own commit: they open from 1px and close from 1px under their height.
 */
const HIDDEN_BY_HAND = { ...HIDDEN, height: 1 } as const;

const REVEAL = {
  /** Tool payloads: "collapse fast, expand soft" (260ms / 160ms). */
  disclosure: { from: HIDDEN_BY_HAND, byHand: true, enter: opened(DUR.expand, EASE.drawer, { duration: 0.16, delay: 0.04 }), exit: COLLAPSE },
  /** A group body the user opens (240ms); closing, by hand or at the end, is 160ms. */
  group: { from: HIDDEN_BY_HAND, byHand: true, enter: opened(0.24, EASE.drawer, { duration: 0.16, delay: 0.04 }), exit: COLLAPSE },
  /** A row, header or section arriving while live (160ms ease-out). */
  arrive: { from: HIDDEN, byHand: false, enter: opened(0.16, EASE.out, { duration: 0.12, delay: 0.03 }), exit: COLLAPSE },
} as const;

type RevealPreset = keyof typeof REVEAL;

const FLOW_ROOT: React.CSSProperties = { display: 'flow-root' };

/**
 * A height-animated body. While it leaves it is out of the a11y tree and
 * inert. `flow-root` keeps child margins inside it whether or not it clips,
 * so its measured height is the height it collapses from.
 */
function RevealBody({ preset, children }: { preset: RevealPreset; children: React.ReactNode }) {
  const present = useIsPresent();
  // A leaving body keeps the props it last rendered with; a closing timing
  // decided as it hides reaches it through AnimatePresence's `custom`.
  const exitTransition = usePresenceData() as Transition | undefined;
  const ref = useRef<HTMLDivElement>(null);
  const { from, byHand, enter } = REVEAL[preset];
  const exit = exitTransition ? { ...REVEAL[preset].exit, transition: exitTransition } : REVEAL[preset].exit;
  // The height a by-hand body collapses from, measured once, on the render
  // that starts its exit (the DOM still has its full height then).
  const exitFromRef = useRef<number | null>(null);
  if (present) exitFromRef.current = null;
  else if (byHand && exitFromRef.current === null) exitFromRef.current = Math.max(0, (ref.current?.offsetHeight ?? 0) - 1);
  const exitFrom = exitFromRef.current;
  useLayoutEffect(() => {
    const el = ref.current;
    if (present || !el || exitFromRef.current === null) return;
    // Motion's first frame writes the same value; this lands it in the commit.
    el.style.overflow = 'hidden';
    el.style.height = `${exitFromRef.current}px`;
  }, [present]);
  return (
    <motion.div
      ref={ref}
      initial={from}
      animate={enter}
      exit={exitFrom === null ? exit : { ...exit, height: [exitFrom, 0] }}
      aria-hidden={present ? undefined : true}
      inert={!present}
      data-reveal={preset}
      style={FLOW_ROOT}
    >
      {children}
    </motion.div>
  );
}

/**
 * Shows/hides `children` with a height + opacity disclosure. Present on the
 * first render: shown settled. `exitTransition`, read as it hides, replaces
 * the preset's closing timing.
 */
export function Reveal({ show, preset = 'disclosure', exitTransition, children }: {
  show: boolean;
  preset?: RevealPreset;
  exitTransition?: Transition;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence initial={false} custom={exitTransition}>
      {show && <RevealBody key="reveal" preset={preset}>{children}</RevealBody>}
    </AnimatePresence>
  );
}

export interface RevealRow {
  key: string;
  node: React.ReactNode;
}

/**
 * Rows that grow in (height 0→auto + fade) when they arrive and collapse when
 * they leave. Rows there when the list mounts render settled. `gap` is
 * padding inside each row's animated box, so it grows in with the row
 * instead of appearing at once like a flex gap.
 */
export function RevealList({ rows, gap = 0 }: { rows: readonly RevealRow[]; gap?: number }) {
  return (
    <AnimatePresence initial={false}>
      {rows.map((row, i) => (
        <RevealBody key={row.key} preset="arrive">
          <div style={{ paddingTop: i > 0 ? gap : 0 }}>{row.node}</div>
        </RevealBody>
      ))}
    </AnimatePresence>
  );
}

const SCROLL_MAX_HEIGHT = 400;
/** How long a new row keeps a scrolled list pinned while it grows in. */
const PIN_MS = 260;

/**
 * A RevealList that scrolls past `scroll` and stays pinned to the newest row
 * unless the user scrolled away. A new row starts at height 0, so the list
 * re-pins every frame while it grows; opening a payload does not scroll.
 */
export function ScrollingRevealList({ rows, gap, scroll }: {
  rows: readonly RevealRow[];
  gap?: number;
  scroll: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const count = rows.length;
  useEffect(() => {
    const el = listRef.current;
    if (!el || !scroll || !stickyRef.current) return;
    const until = performance.now() + PIN_MS;
    let frame = 0;
    const pin = () => {
      if (!stickyRef.current) return;
      el.scrollTop = el.scrollHeight;
      if (performance.now() < until) frame = requestAnimationFrame(pin);
    };
    pin();
    return () => cancelAnimationFrame(frame);
  }, [count, scroll]);
  return (
    <div
      ref={listRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stickyRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
      className={scroll ? 'term-scrollbar' : undefined}
      style={scroll ? { maxHeight: SCROLL_MAX_HEIGHT, overflowY: 'auto' } : undefined}
    >
      <RevealList rows={rows} gap={gap} />
    </div>
  );
}

/**
 * A section that appears after its card mounted grows in (160ms); one shown
 * from the start renders settled. Hiding is immediate: nothing lingers.
 */
export function RevealOnShow({ show, children }: { show: boolean; children: React.ReactNode }) {
  const [shownAtMount] = useState(show);
  if (!show) return null;
  return (
    <OwnEntrance>
      <motion.div initial={shownAtMount ? false : HIDDEN} animate={REVEAL.arrive.enter} style={FLOW_ROOT}>{children}</motion.div>
    </OwnEntrance>
  );
}

/* ── Glyphs and labels ───────────────────────────────────────────────── */

const SCALE_FROM = { opacity: 0, scale: 0.5 } as const;
const SCALE_IN: TargetAndTransition = { opacity: 1, scale: 1, transition: SPRING.snappy };
const SCALE_OUT: TargetAndTransition = { opacity: 0, scale: 0.5, transition: { duration: DUR.soft, ease: EASE.out } };
const GLYPH_LAYER: React.CSSProperties = { gridArea: '1 / 1', display: 'inline-flex', alignItems: 'center' };
const GLYPH_LAYER_LEAVING: React.CSSProperties = { ...GLYPH_LAYER, pointerEvents: 'none' };

/** A leaving glyph or label is no longer announced or clickable. */
function GlyphLayer({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.span initial={SCALE_FROM} animate={SCALE_IN} exit={SCALE_OUT} style={present ? GLYPH_LAYER : GLYPH_LAYER_LEAVING} aria-hidden={present ? undefined : true}>
      {children}
    </motion.span>
  );
}

/**
 * A status glyph slot. When `glyph` (the kind: running, done, failed…)
 * changes, the old glyph shrinks out in 100ms while the new one springs in;
 * the first glyph renders settled. Glyph content sets its own aria-hidden.
 */
export function GlyphSwap({ glyph, justify = 'start', style, children }: {
  glyph: string;
  justify?: 'start' | 'center' | 'end';
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <span style={{ display: 'inline-grid', alignItems: 'center', justifyItems: justify, flexShrink: 0, ...style }}>
      <AnimatePresence initial={false}>
        <GlyphLayer key={glyph}>{children}</GlyphLayer>
      </AnimatePresence>
    </span>
  );
}

const DRAW_FROM = { pathLength: 0 } as const;
const DRAW_TO: TargetAndTransition = { pathLength: 1, transition: { duration: 0.22, ease: EASE.out } };

/** An SVG stroke drawn in (220ms) when its glyph swaps in; settled otherwise. */
export function DrawnPath({ d }: { d: string }) {
  return <motion.path d={d} initial={DRAW_FROM} animate={DRAW_TO} />;
}

const DIGIT_FROM = { opacity: 0, y: '0.6em' } as const;
const DIGIT_IN: TargetAndTransition = { opacity: 1, y: 0, transition: { duration: DUR.enter, ease: EASE.out } };
const DIGIT_OUT: TargetAndTransition = { opacity: 0, y: '-0.6em', transition: { duration: 0.12, ease: EASE.out } };
const DIGIT_LAYER: React.CSSProperties = { gridArea: '1 / 1' };

function DigitLayer({ children }: { children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.span initial={DIGIT_FROM} animate={DIGIT_IN} exit={DIGIT_OUT} style={DIGIT_LAYER} aria-hidden={present ? undefined : true}>
      {children}
    </motion.span>
  );
}

/**
 * A counter that rolls: each place whose digit changes sends the old digit up
 * and out as the new one rises in, and places that hold stay still, so a
 * ticking clock reads as a count rather than a re-printed string. The digits
 * it mounts with render settled; a place gained later (9 → 10) rolls in.
 * Tabular figures keep every place one width.
 */
export function RollingNumber({ value }: { value: number }) {
  const digits = String(Math.max(0, Math.floor(value))).split('');
  const [placesAtMount] = useState(digits.length);
  return (
    <OwnEntrance>
      <span style={{ display: 'inline-flex', fontVariantNumeric: 'tabular-nums' }}>
        {digits.map((digit, i) => {
          const place = digits.length - 1 - i;
          return (
            <span key={place} style={{ display: 'inline-grid' }}>
              <AnimatePresence initial={place >= placesAtMount}>
                <DigitLayer key={digit}>{digit}</DigitLayer>
              </AnimatePresence>
            </span>
          );
        })}
      </span>
    </OwnEntrance>
  );
}

const LABEL_FROM = { opacity: 0, y: 4 } as const;
const LABEL_IN: TargetAndTransition = { opacity: 1, y: 0, transition: { duration: DUR.enter, ease: EASE.out, delay: 0.03 } };
const LABEL_OUT: TargetAndTransition = { opacity: 0, y: -4, transition: { duration: 0.12, ease: EASE.out } };

function LabelLayer({ as, style, children }: { as: 'span' | 'div'; style?: React.CSSProperties; children: React.ReactNode }) {
  const present = useIsPresent();
  const Layer = as === 'div' ? motion.div : motion.span;
  return (
    <Layer
      initial={LABEL_FROM}
      animate={LABEL_IN}
      exit={LABEL_OUT}
      aria-hidden={present ? undefined : true}
      style={{ gridArea: '1 / 1', minWidth: 0, pointerEvents: present ? undefined : 'none', ...style }}
    >
      {children}
    </Layer>
  );
}

/**
 * A header label that cross-fades when `k` (its mode: running, done,
 * collapsed…) changes, e.g. "running tools" into the collapsed summary. Text
 * updates within one mode render in place. The outgoing label is aria-hidden.
 * `as="div"` for a label of block content.
 */
export function LabelSwap({ k, as = 'span', style, layerStyle, children }: {
  k: string;
  as?: 'span' | 'div';
  style?: React.CSSProperties;
  layerStyle?: React.CSSProperties;
  children: React.ReactNode;
}) {
  const Slot = as;
  return (
    <Slot style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, ...style }}>
      <AnimatePresence initial={false}>
        <LabelLayer key={k} as={as} style={layerStyle}>{children}</LabelLayer>
      </AnimatePresence>
    </Slot>
  );
}

const FADE_FROM = { opacity: 0 } as const;
const FADE_IN: TargetAndTransition = { opacity: 1, transition: { duration: 0.16, ease: 'linear' } };

/**
 * Status words and small inline marks: when `k` changes the new content fades
 * in (`variant="scale"`: springs in from half size); `null` renders nothing.
 * The content shown on the first render, and a later return to it, render
 * settled. The old content goes at once, so a status word never appears
 * twice in a line's text or accessible name.
 */
export function FadeOnChange({ k, variant = 'fade', style, className, children }: {
  k: string | null;
  variant?: 'fade' | 'scale';
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
}) {
  const [mountKey] = useState(k);
  if (k === null) return null;
  const from = variant === 'scale' ? SCALE_FROM : FADE_FROM;
  const to = variant === 'scale' ? SCALE_IN : FADE_IN;
  return (
    <OwnEntrance>
      <motion.span key={k} initial={k === mountKey ? false : from} animate={to} style={style} className={className}>
        {children}
      </motion.span>
    </OwnEntrance>
  );
}

const FLASH_STYLE: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--term-danger)',
  pointerEvents: 'none',
};
const FLASH_FROM = { opacity: 0.14 } as const;
const FLASH_TO: TargetAndTransition = { opacity: 0, transition: { duration: DUR.slow, ease: 'easeOut' } };

/**
 * One danger-tinted fade (600ms) over a row that fails while shown. A row
 * failed when it mounted does not flash. The parent must be positioned.
 */
export function FailFlash({ failed }: { failed: boolean }) {
  const [failedAtMount] = useState(failed);
  if (!failed || failedAtMount) return null;
  return (
    <OwnEntrance>
      <motion.span aria-hidden data-fail-flash="" initial={FLASH_FROM} animate={FLASH_TO} style={FLASH_STYLE} />
    </OwnEntrance>
  );
}

/**
 * An AnimatePresence child memoises its first-render `initial={false}` for
 * every motion descendant, including ones that mount later. Elements that
 * decide their own entrance (and never need an exit) opt out of it.
 */
function OwnEntrance({ children }: { children: React.ReactNode }) {
  return <PresenceContext.Provider value={null}>{children}</PresenceContext.Provider>;
}

/* ── The 'line' chrome (W2 · outcome-first) ──────────────────────────────
   One 28px row per run whose words change in place. Only transform and
   opacity move; layout changes once, in the frame of the click. */

const LINE_LEAD_FROM = { opacity: 0, y: LINE_MOTION.shift } as const;
const LINE_LEAD_IN: TargetAndTransition = {
  opacity: 1, y: 0, transition: { duration: LINE_MOTION.labelIn, delay: LINE_MOTION.labelDelay, ease: EASE.out },
};
const LINE_LEAD_OUT: TargetAndTransition = { opacity: 0, y: -LINE_MOTION.shift, transition: { duration: LINE_MOTION.labelOut, ease: EASE.out } };
const LINE_REST_FROM = { opacity: 0 } as const;
const LINE_REST_IN: TargetAndTransition = {
  opacity: 1, transition: { duration: LINE_MOTION.restIn, delay: LINE_MOTION.restDelay, ease: EASE.out },
};
const LINE_REST_OUT: TargetAndTransition = { opacity: 0, transition: { duration: LINE_MOTION.restOut, ease: 'linear' } };

function LineLayer({ rest, className, translate, children }: {
  rest: boolean;
  className?: string;
  translate?: 'no';
  children: React.ReactNode;
}) {
  const present = useIsPresent();
  return (
    <motion.span
      className={className}
      translate={translate}
      initial={rest ? LINE_REST_FROM : LINE_LEAD_FROM}
      animate={rest ? LINE_REST_IN : LINE_LEAD_IN}
      exit={rest ? LINE_REST_OUT : LINE_LEAD_OUT}
      aria-hidden={present ? undefined : true}
      data-leaving={present ? undefined : ''}
    >
      {children}
    </motion.span>
  );
}

/**
 * A line's lead or rest. A new `k` swaps in place: both layers share one grid
 * cell, so nothing reflows. The lead rises out (120ms) and in (180ms, +40ms);
 * the rest dips: out in place (90ms), back once the lead has settled. Reduced
 * motion keeps only the opacity. The first label renders settled.
 */
export function LineSwap({ k, rest = false, className, layerClassName, id, ariaHidden, translate, children }: {
  /** The layer's identity; null shows no layer (an empty rest leaves no empty layer behind). */
  k: string | null;
  rest?: boolean;
  className?: string;
  layerClassName?: string;
  id?: string;
  ariaHidden?: boolean;
  translate?: 'no';
  children: React.ReactNode;
}) {
  return (
    <span className={className} id={id} aria-hidden={ariaHidden || undefined}>
      <AnimatePresence initial={false}>
        {k !== null && <LineLayer key={k} rest={rest} className={layerClassName} translate={translate}>{children}</LineLayer>}
      </AnimatePresence>
    </span>
  );
}

const LINE_GLYPH_FROM = { opacity: 0, scale: LINE_MOTION.glyphFrom } as const;
const LINE_GLYPH_IN: TargetAndTransition = { opacity: 1, scale: 1, transition: { duration: LINE_MOTION.glyphIn, ease: EASE.out } };
const LINE_GLYPH_OUT: TargetAndTransition = {
  opacity: 0, scale: LINE_MOTION.glyphFrom, transition: { duration: LINE_MOTION.glyphOut, ease: EASE.out },
};

function LineGlyphLayer({ className, children }: { className?: string; children: React.ReactNode }) {
  const present = useIsPresent();
  return (
    <motion.span className={className} initial={LINE_GLYPH_FROM} animate={LINE_GLYPH_IN} exit={LINE_GLYPH_OUT} data-leaving={present ? undefined : ''}>
      {children}
    </motion.span>
  );
}

/** The hanging status glyph: a new `glyph` scales in from .6 as the old one leaves. */
export function LineGlyphSwap({ glyph, className, layerClassName, children }: {
  glyph: string;
  className?: string;
  layerClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={className} aria-hidden>
      <AnimatePresence initial={false}>
        <LineGlyphLayer key={glyph} className={layerClassName}>{children}</LineGlyphLayer>
      </AnimatePresence>
    </span>
  );
}

const LINE_FLASH_FROM = { opacity: LINE_MOTION.flashFrom } as const;
const LINE_FLASH_TO: TargetAndTransition = { opacity: 0, transition: { duration: LINE_MOTION.flash, ease: 'easeOut' } };

/** One 12% → 0 danger tint (700ms) when a failure arrives on a shown line. None under reduced motion. */
export function LineFlash({ on, className }: { on: boolean; className?: string }) {
  const [onAtMount] = useState(on);
  const reduce = useReducedMotionConfig();
  if (!on || onAtMount || reduce) return null;
  return (
    <OwnEntrance>
      <motion.span aria-hidden data-fail-flash="" className={className} initial={LINE_FLASH_FROM} animate={LINE_FLASH_TO} />
    </OwnEntrance>
  );
}

interface DrawerSnapshot {
  reduce: boolean;
  bodyTop: number;
  bodyHeight: number;
  followers: Array<{ el: HTMLElement; top: number }>;
}

const MAX_FOLLOWERS = 40;
const cssBezier = ([a, b, c, d]: readonly number[]) => `cubic-bezier(${a}, ${b}, ${c}, ${d})`;

function scrollParentOf(el: HTMLElement): HTMLElement | null {
  for (let n = el.parentElement; n; n = n.parentElement) {
    const overflow = getComputedStyle(n).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return n;
  }
  return null;
}

/** Everything after `el` inside its scroller: what the drawer's edge pushes. */
function followersOf(el: HTMLElement): HTMLElement[] {
  const stop = scrollParentOf(el);
  const out: HTMLElement[] = [];
  for (let n: HTMLElement | null = el; n && n !== stop && n !== document.body; n = n.parentElement) {
    for (let s = n.nextElementSibling; s && out.length < MAX_FOLLOWERS; s = s.nextElementSibling) {
      if (s instanceof HTMLElement) out.push(s);
    }
  }
  return out;
}

export interface LineDrawer {
  open: boolean;
  /** While closing, the body is an absolutely positioned, inert ghost at this top. */
  ghostTop: number | null;
  toggle: () => void;
  bodyRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * A disclosure whose layout changes once, in the frame of the click: opening
 * puts the body in flow, closing takes it out of flow (an inert ghost stays
 * where it was). Then only transforms move: the body slides out from under its
 * row (260ms) or back under it (180ms) on the drawer curve, clipped to its own
 * box, and the blocks below follow its edge (FLIP from where they were drawn,
 * composited, so a toggle mid-way reverses from where things are). Under
 * reduced motion an open fades in (140ms) and a close is instant.
 */
export function useLineDrawer(initialOpen = false): LineDrawer {
  const reduce = !!useReducedMotionConfig();
  const [state, setState] = useState<{ open: boolean; ghostTop: number | null }>({ open: initialOpen, ghostTop: null });
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const snapRef = useRef<DrawerSnapshot | null>(null);
  const animsRef = useRef<Animation[]>([]);
  const mountedRef = useRef(false);

  const toggle = useCallback(() => {
    const body = bodyRef.current;
    let snap: DrawerSnapshot | null = null;
    if (body && typeof body.animate === 'function' && !MotionGlobalConfig.skipAnimations) {
      const followers = reduce ? [] : followersOf(body);
      // One batch of reads before any write: where everything is drawn now.
      const rects = followers.map((el) => el.getBoundingClientRect());
      const vh = window.innerHeight;
      snap = {
        reduce,
        bodyTop: body.offsetTop,
        bodyHeight: body.offsetHeight,
        followers: followers
          .map((el, i) => ({ el, top: rects[i].top }))
          .filter((_, i) => rects[i].bottom > -64 && rects[i].top < vh + 64),
      };
    }
    snapRef.current = snap;
    setState((s) => (s.open
      ? { open: false, ghostTop: snap && !snap.reduce ? snap.bodyTop : null }
      : { open: true, ghostTop: null }));
  }, [reduce]);

  useLayoutEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    const snap = snapRef.current;
    snapRef.current = null;
    for (const a of animsRef.current) a.cancel();
    animsRef.current = [];
    const body = bodyRef.current;
    const inner = body?.firstElementChild instanceof HTMLElement ? body.firstElementChild : null;
    if (!snap || !body) return;
    if (snap.reduce) {
      if (state.open && inner) animsRef.current = [inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: LINE_MOTION.drawerFadeIn * 1000, easing: 'linear' })];
      return;
    }
    const open = state.open;
    const height = open ? body.offsetHeight : snap.bodyHeight;
    const duration = (open ? LINE_MOTION.drawerOpen : LINE_MOTION.drawerClose) * 1000;
    const easing = cssBezier(EASE.drawer);
    // Reads (where layout put the followers), then writes.
    const moved = snap.followers.map(({ el, top }) => ({ el, dy: top - el.getBoundingClientRect().top }));
    const anims: Animation[] = [];
    for (const { el, dy } of moved) {
      if (Math.abs(dy) < 0.5) continue;
      anims.push(el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0px)' }], { duration, easing, composite: 'add' }));
    }
    if (!inner) { animsRef.current = anims; return; }
    body.style.clipPath = 'inset(0 -64px)';
    const slide = inner.animate(
      open ? [{ transform: `translateY(${-height}px)` }, { transform: 'translateY(0px)' }] : [{ transform: 'translateY(0px)' }, { transform: `translateY(${-height}px)` }],
      { duration, easing, fill: 'forwards' },
    );
    const fade = inner.animate(open ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], {
      duration: duration * (open ? 0.7 : 0.8), easing: 'linear', fill: 'forwards',
    });
    anims.push(slide, fade);
    animsRef.current = anims;
    slide.onfinish = () => {
      body.style.clipPath = '';
      animsRef.current = [];
      if (open) {
        slide.cancel();
        fade.cancel();
      } else {
        // The ghost leaves with its fill still on: it never shows again.
        setState((s) => (s.open || s.ghostTop === null ? s : { ...s, ghostTop: null }));
      }
    };
  }, [state.open]);

  useEffect(() => () => { for (const a of animsRef.current) a.cancel(); }, []);

  return { open: state.open, ghostTop: state.ghostTop, toggle, bodyRef };
}

/** The body a useLineDrawer controls. Its children mount only while open or leaving. */
export function LineDrawerBody({ drawer, id, className, innerClassName, children }: {
  drawer: LineDrawer;
  id: string;
  className?: string;
  innerClassName?: string;
  children: React.ReactNode;
}) {
  const ghost = !drawer.open && drawer.ghostTop !== null;
  const mounted = drawer.open || ghost;
  return (
    <div
      id={id}
      ref={drawer.bodyRef}
      className={className}
      hidden={!mounted}
      inert={ghost || undefined}
      aria-hidden={ghost || undefined}
      data-leaving={ghost ? '' : undefined}
      style={ghost ? { position: 'absolute', left: 0, right: 0, top: drawer.ghostTop ?? 0, pointerEvents: 'none' } : undefined}
    >
      {mounted ? <div className={innerClassName}>{children}</div> : null}
    </div>
  );
}
