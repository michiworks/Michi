import { encodeNodeMentionToken } from './nodeMentionTokens';

export interface MentionRecord {
  /** Inclusive: index of the leading '@' in the textarea value. */
  start: number;
  /** Exclusive: index of the first char after the chip body. */
  end: number;
  kind: 'context' | 'node';
  /** contextId for kind='context'; nodeId for kind='node'. */
  refId: string;
  /** Display label (without leading @). What the chip renders. */
  label: string;
}

/**
 * Convert a draft `(value, mentions)` into the wire string sent to the agent.
 * Context mentions are kept as `@<name>` (already in the value), node mentions
 * are rewritten to `@node:<encoded-id>`. MentionRecord.refId stays unchanged.
 *
 * Assumes mentions are sorted by `start` and non-overlapping.
 */
export function expandMentions(value: string, mentions: MentionRecord[]): string {
  if (mentions.length === 0) return value;
  let out = '';
  let cursor = 0;
  for (const m of mentions) {
    out += value.slice(cursor, m.start);
    if (m.kind === 'context') {
      out += `@${m.label}`;
    } else {
      out += encodeNodeMentionToken(m.refId);
    }
    cursor = m.end;
  }
  out += value.slice(cursor);
  return out;
}
