import React, { useState } from 'react';
import { motion, type Transition } from 'motion/react';
import { DUR, EASE } from '../../motion/tokens';
import type { OpenState } from '../../state/sidebarSelectors';
import type { UnreadMark } from './UnreadDot';

/** A branch row's rail drawing down as the row arrives: a layout move, a beat behind the row. */
const DRAW_IN: Transition = { duration: DUR.move, delay: 0.04, ease: EASE.out };

/**
 * The running rail's exit. A sidebar row's right-edge rail pulses in the run
 * colour while its chat runs; when the run ends the row's own rail either unmounts or
 * drops to the static "open" look at once. This draws the live rail one last
 * time over that spot and fades it out (`.sb-rail-afterglow` in index.css),
 * so "finished" reads as the rail going out rather than blinking off. In
 * Classic rows the unread dot pops a beat later (see `.sb-unread-dot`), once
 * the rail has started to go.
 *
 * `handoff`: the rail stays to mark the finished reply unread (card modes,
 * see SidebarOpenRail), so nothing goes out and nothing fades. Unread landing
 * just after the run ended drops a fade already playing.
 *
 * Only a live → not-live change in a mounted row plays it: a row that mounts
 * idle, or hydrates already finished, draws nothing. A run that restarts
 * mid-fade drops the afterglow and the row's own live rail takes over.
 *
 * Render it before the row's own rail so callers that treat the rail as the
 * row's last child keep finding it.
 */
export function RailAfterglow({ live, right, handoff = false }: { live: boolean; right: number; handoff?: boolean }) {
  const [prevLive, setPrevLive] = useState(live);
  const [fading, setFading] = useState(false);
  if (live !== prevLive) {
    setPrevLive(live);
    setFading(!live && !handoff);
  } else if (fading && handoff) {
    setFading(false);
  }
  if (!fading) return null;
  return (
    <span
      aria-hidden
      data-testid="rail-afterglow"
      className="sb-rail-afterglow"
      style={{ right }}
      onAnimationEnd={() => setFading(false)}
    />
  );
}

/**
 * A sidebar row's right-edge rail and its afterglow, the same in thread,
 * branch and workspace rows. Running is the run colour, pulsing with a glow;
 * a merely open pane's rail is the brand accent in Classic and neutral in
 * card modes. It sits on the right edge in every mode: card modes briefly had
 * it on the left as an inset strip, which read as a stray marker.
 *
 * `unread` (card modes; Classic keeps its dot): a reply nobody has seen paints
 * the rail green, the success colour, for a row's own reply and for one hidden
 * in a collapsed subtree alike. Running beats unread, which beats open: all
 * three are one rail of one size in one place, and only the colour says which.
 * A run that ends unread turns its rail green where it stood instead of
 * putting it out.
 *
 * `waiting` (a turn that waits on you, RowAttention): the rail is the
 * waiting colour and holds still, ahead of running. The turn has not ended,
 * so the run rail hands over to it and leaves no afterglow.
 *
 * `pulseOnce` blinks an idle rail for a pane just opened (useNewPanePulse).
 * With `drawIn` given the rail is a motion span, drawing down from the top
 * when it is true (a branch row's entrance).
 */
export function SidebarOpenRail({ state, isCard, pulseOnce = false, drawIn, unread = 'none', waiting = false }: {
  state: OpenState;
  isCard: boolean;
  pulseOnce?: boolean;
  drawIn?: boolean;
  unread?: UnreadMark;
  waiting?: boolean;
}) {
  const right = isCard ? 3 : 2;
  const mark = waiting ? 'waiting' : state === 'streaming' ? 'streaming' : unread !== 'none' ? 'unread' : state;
  const streaming = mark === 'streaming';
  const style: React.CSSProperties = {
    position: 'absolute',
    right,
    top: 5,
    bottom: 5,
    width: 2,
    // Square ends: a 2px rail is structure, not a floating control, and a
    // pill's caps on it read as a smudge rather than a radius.
    borderRadius: 0,
    // `color` feeds the glow's currentColor.
    color: streaming ? 'var(--term-run)' : 'var(--term-accent)',
    background: streaming
      ? 'var(--term-run)'
      : mark === 'waiting' ? 'var(--term-waiting)'
      : mark === 'unread' ? 'var(--term-digest)' : (isCard ? 'var(--term-line-s)' : 'var(--term-accent)'),
    boxShadow: streaming ? '0 0 6px 0 currentColor' : undefined,
    // Only turning green eases: run to unread keeps the rail and changes its
    // colour. Every other change is a status swap and lands at once.
    transition: mark === 'unread' ? 'background-color var(--t-decay) var(--t-ease)' : undefined,
    // The running pulse is the running dot's class, which Reduce motion stops.
    animation: !streaming && !waiting && pulseOnce ? 'bar-pulse-once var(--t-slow) ease-in-out 2' : undefined,
    pointerEvents: 'none',
  };
  const className = streaming ? 'term-dot-i--run' : undefined;
  return (
    <>
      <RailAfterglow live={streaming} right={right} handoff={mark === 'unread' || waiting} />
      {mark !== 'none' && (drawIn === undefined
        ? <span aria-hidden data-rail={mark} className={className} style={style} />
        : (
          <motion.span
            aria-hidden
            data-rail={mark}
            className={className}
            initial={drawIn ? { scaleY: 0 } : false}
            animate={{ scaleY: 1 }}
            transition={DRAW_IN}
            style={{ originY: 0, ...style }}
          />
        ))}
    </>
  );
}
