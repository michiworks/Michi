import { scanTurnMetadataSentinels } from 'michi-shared';

const SINGLE_INLINE_FOLLOW_UPS_RE = /^\[FOLLOW-UPS:\s*([^\]]+)\]$/i;

export function parseInlineFollowUpsSentinel(text: string): string[] {
  const match = text.match(SINGLE_INLINE_FOLLOW_UPS_RE);
  if (!match) return [];
  return match[1]
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 3);
}

/**
 * Derive a persisted node title from the first user message when the agent
 * never emitted a `[TITLE:]` sentinel or a structured title event. Also used
 * for display-only labels while waiting for the main response; those labels
 * must not fill the durable title before agent metadata arrives.
 */
export { deriveConversationTitle as deriveTitleFromUserText } from 'michi-shared';

// ── Streaming-safe sentinel stripping ────────────────────────────────────
//
// Turn-end parsing (shared finalizeTurnContent) `trim()`s and only strips
// sentinels once they're fully formed. During streaming a half-formed
// `[TITLE: abc` has to disappear from the visible text *immediately* — if
// we let it appear and then strip when `]` arrives, useSmooth's source
// shrinks and the cursor resets, which is exactly the "字消失" failure mode
// we're redesigning to eliminate.
//
// Contract:
//   - visibleText is monotonic: appending raw characters never shortens it.
//     Tail bytes that *could* still extend into a sentinel prefix are held
//     out of visibleText. Once they can't (e.g. `[n` — `n` ∉ next-char of
//     `[TITLE:` or `[FOLLOW-UP`), they release immediately.
//   - Plain prose `[note]` and markdown links `[a](b)` pass through unchanged.
//   - `remapOffset(rawOff)` maps a raw-buffer offset to the corresponding
//     visibleText offset (used by tool-call `textOffset`).
//
// Sentinel detection is shared's scanTurnMetadataSentinels, which also
// produces the persisted content and the backend's projections.

export interface VisibleProjection {
  visibleText: string;
  /** Map a raw-buffer offset → visibleText offset. Stable for the given raw. */
  remapOffset: (rawOff: number) => number;
  /**
   * Unresolved sentinel-looking tail held out of visibleText. Block-first
   * answer runs pass this to the next answer run so `[TITLE:` split by a
   * thinking block can still resolve without rescanning the whole message.
   */
  pendingRawTail?: string;
}

/**
 * Streaming-safe sentinel stripping. Produces a visibleText that is monotonic
 * across raw extensions (appending characters never shortens visibleText) and
 * a `remapOffset` for tool-call positioning.
 */
export function stripSentinelsStreamingSafe(raw: string): VisibleProjection {
  // `cuts` records [rawStart, rawEnd) regions that are excluded from visibleText.
  // Used both for projection and for remapOffset.
  type Cut = { start: number; end: number };
  const { cuts, pendingStart } = scanTurnMetadataSentinels(raw);

  // An unresolved tail stays OUT of visibleText (monotonic guarantee — once
  // `]` arrives we'll see whether it's a sentinel). Add the tail as a cut so
  // visibleText omits it; remapOffset clamps offsets inside it to its start.
  const pendingTail: Cut | null = pendingStart >= 0 ? { start: pendingStart, end: raw.length } : null;

  // Build visibleText by skipping cut + pendingTail regions.
  const allCuts = pendingTail ? [...cuts, pendingTail] : cuts;
  let visibleText = '';
  let cursor = 0;
  for (const c of allCuts) {
    if (c.start > cursor) visibleText += raw.slice(cursor, c.start);
    cursor = c.end;
  }
  if (cursor < raw.length) visibleText += raw.slice(cursor);

  function remapOffset(rawOff: number): number {
    let removed = 0;
    let off = rawOff;
    for (const c of allCuts) {
      if (rawOff <= c.start) break;
      if (rawOff < c.end) {
        // Inside a cut region — snap to the start (i.e. the same point in
        // visibleText where the cut was elided).
        off = c.start;
        break;
      }
      removed += c.end - c.start;
    }
    return Math.max(0, Math.min(off - removed, visibleText.length));
  }

  return {
    visibleText,
    remapOffset,
    pendingRawTail: pendingTail ? raw.slice(pendingTail.start, pendingTail.end) : undefined,
  };
}

/**
 * Single-source projection helper: given a `ChatMessage` whose `text` field
 * is the raw stream buffer, return the user-visible string + offset remapper.
 * Every UI/export/search/digest/copy/mobile path that reads "what the user
 * should see" must go through this helper so sentinels never leak.
 */
export function deriveVisibleMessage(m: { text: string }): VisibleProjection {
  return stripSentinelsStreamingSafe(m.text);
}
