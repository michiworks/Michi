/**
 * Geometry and labels for the phone transcript scrubber (TranscriptScrubber.tsx):
 * a handle on the transcript's right edge that, held and dragged, scrolls the
 * transcript in proportion to its position and names the question at that point.
 */

/** Where the reading line sits, as a fraction of the transcript's height from its top. */
export const SCRUB_READING_LINE = 0.25;
/** The scrubber appears only for conversations with this many questions... */
const SCRUB_MIN_QUESTIONS = 4;
/** ...and at least this many screens of content. */
const SCRUB_MIN_SCREENS = 3;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function scrubberAvailable(questions: number, scrollHeight: number, clientHeight: number): boolean {
  return questions >= SCRUB_MIN_QUESTIONS && clientHeight > 0 && scrollHeight >= clientHeight * SCRUB_MIN_SCREENS;
}

/** Scroll position → thumb fraction in [0, 1]. */
export function fractionForScroll(scrollTop: number, maxScroll: number): number {
  return maxScroll > 0 ? clamp(scrollTop / maxScroll, 0, 1) : 0;
}

/** Thumb fraction → the thumb's centre, in px from the track's top. */
export function thumbCenter(fraction: number, trackHeight: number, thumbHeight: number): number {
  return thumbHeight / 2 + clamp(fraction, 0, 1) * Math.max(0, trackHeight - thumbHeight);
}

/** The thumb's centre (px from the track's top) → thumb fraction in [0, 1]. */
export function fractionForThumb(center: number, trackHeight: number, thumbHeight: number): number {
  const travel = trackHeight - thumbHeight;
  return travel > 0 ? clamp((center - thumbHeight / 2) / travel, 0, 1) : 0;
}

/**
 * Index of the last of `count` items, ordered top to bottom, whose top is at or
 * above `line`; 0 when none is (the first question names the space above it),
 * -1 when there are none. Reads `topAt` O(log n) times.
 */
export function lastAtOrAbove(count: number, topAt: (index: number) => number, line: number): number {
  if (count <= 0) return -1;
  let lo = 0, hi = count - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (topAt(mid) <= line) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/**
 * The words a user message's label shows: the user's own text on one line.
 * Older messages carry a quoted passage as leading `> ` lines; those are left
 * out unless the message is nothing but a quote.
 */
export function scrubLabelText(message: { text?: string; attachments?: readonly unknown[] }): string {
  const lines = (message.text ?? '').split('\n');
  const oneLine = (ls: string[]) => ls.join(' ').replace(/\s+/g, ' ').trim();
  const own = oneLine(lines.filter((l) => !/^\s*>/.test(l)));
  if (own) return own;
  const quoted = oneLine(lines.map((l) => l.replace(/^\s*>\s?/, '')));
  if (quoted) return quoted;
  const files = message.attachments?.length ?? 0;
  return files ? `${files} attachment${files === 1 ? '' : 's'}` : 'Message';
}
