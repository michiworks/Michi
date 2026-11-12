import React, { useState } from 'react';
import { motion } from 'motion/react';
import { EASE } from '../../motion/tokens';
import type { OpenState } from '../../state/sidebarSelectors';

/**
 * The running rail's exit. A sidebar row's right-edge rail pulses in the run
 * colour while its chat runs; when the run ends the row's own rail either unmounts or
 * drops to the static "open" look at once. This draws the live rail one last
 * time over that spot and fades it out (`.sb-rail-afterglow` in index.css),
 * so "finished" reads as the rail going out rather than blinking off. The
 * unread dot pops a beat later (see `.sb-unread-dot`), once the rail has
 * started to go.
 *
 * Only a live → not-live change in a mounted row plays it: a row that mounts
 * idle, or hydrates already finished, draws nothing. A run that restarts
 * mid-fade drops the afterglow and the row's own live rail takes over.
 *
 * Render it before the row's own rail so callers that treat the rail as the
 * row's last child keep finding it.
 */
export function RailAfterglow({ live, right }: { live: boolean; right: number }) {
  const [prevLive, setPrevLive] = useState(live);
  const [fading, setFading] = useState(false);
  if (live !== prevLive) {
    setPrevLive(live);
    setFading(!live);
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
 * `pulseOnce` blinks an idle rail for a pane just opened (useNewPanePulse).
 * With `drawIn` given the rail is a motion span, drawing down from the top
 * when it is true (a branch row's entrance).
 */
export function SidebarOpenRail({ state, isCard, pulseOnce = false, drawIn }: {
  state: OpenState;
  isCard: boolean;
  pulseOnce?: boolean;
  drawIn?: boolean;
}) {
  const right = isCard ? 3 : 2;
  const streaming = state === 'streaming';
  const style: React.CSSProperties = {
    position: 'absolute',
    right,
    top: 5,
    bottom: 5,
    width: 2,
    borderRadius: 'var(--ui-radius-pill)',
    // `color` feeds the glow's currentColor.
    color: streaming ? 'var(--term-run)' : 'var(--term-accent)',
    background: streaming ? 'var(--term-run)' : (isCard ? 'var(--term-line-s)' : 'var(--term-accent)'),
    boxShadow: streaming ? '0 0 6px 0 currentColor' : undefined,
    // The running pulse is the running dot's class, which Reduce motion stops.
    animation: !streaming && pulseOnce ? 'bar-pulse-once var(--t-slow) ease-in-out 2' : undefined,
    pointerEvents: 'none',
  };
  const className = streaming ? 'term-dot-i--run' : undefined;
  return (
    <>
      <RailAfterglow live={streaming} right={right} />
      {state !== 'none' && (drawIn === undefined
        ? <span aria-hidden className={className} style={style} />
        : (
          <motion.span
            aria-hidden
            className={className}
            initial={drawIn ? { scaleY: 0 } : false}
            animate={{ scaleY: 1 }}
            transition={{ duration: 0.22, delay: 0.04, ease: EASE.out }}
            style={{ originY: 0, ...style }}
          />
        ))}
    </>
  );
}
