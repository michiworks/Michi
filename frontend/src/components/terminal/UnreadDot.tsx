/**
 * Classic sidebar rows' unread marker: a small green dot in the gutter left of
 * a row's text. Card modes paint the row's right-edge rail green instead
 * (SidebarOpenRail), which leaves their gutter to the pin star. The levels
 * below and the colour are the same there.
 *
 * - `self`: this row's own reply finished after you last opened it.
 * - `within`: a collapsed row (thread, branch or workspace) whose hidden
 *   children hold such a reply. Drawn as a ring; once the row is expanded the
 *   children carry their own dots and the ring goes away.
 *
 * Green (`--term-digest`) matches the Map card's unread dot. Running is the
 * right-edge rail in its own colour, so in Classic the two signals differ in
 * both colour and side; on a card row's rail, which shows one at a time, in
 * colour.
 *
 * The span is always mounted and only scaled (see `.sb-unread-dot` in
 * index.css). A row that hydrates or expands already unread paints settled, and
 * a reply that lands on a visible row pops its dot in.
 */
export type UnreadMark = 'none' | 'self' | 'within';

/** Title weight for a row that is itself unread. Replaces the old 900, which
 *  CJK titles could not show: PingFang tops out at Semibold, so 900 rendered
 *  barely heavier than the 450 used for read rows. Colour does most of the
 *  work now (mid → fg) and the dot carries the signal on its own. */
export const UNREAD_TITLE_WEIGHT = 520;

export function UnreadDot({ mark, left, inline = false }: {
  mark: UnreadMark;
  /** Absolute left offset from the containing block. Ignored when `inline`. */
  left?: string | number;
  /** Lay the dot out in the flow instead of in the gutter (classic workspace
   *  rows have no gutter wide enough for it). */
  inline?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={inline ? 'sb-unread-dot sb-unread-dot--inline' : 'sb-unread-dot'}
      data-unread={mark}
      style={inline ? undefined : { left }}
    />
  );
}
