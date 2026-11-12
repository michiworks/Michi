import { formatQuotedSelectionContext } from '../lib/quoteFormat';
import type { ComposerDraft } from './chatTypes';

export function normalizeComposerDraft(draft: ComposerDraft | null): ComposerDraft | null {
  if (!draft) return null;
  const value = draft.value ?? '';
  const mentions = Array.isArray(draft.mentions) ? draft.mentions : [];
  const quotedText = draft.quotedText?.trim() ? draft.quotedText : undefined;
  if (!value && mentions.length === 0 && !quotedText) return null;
  return { value, mentions, quotedText, ...(quotedText && draft.quoteSource ? { quoteSource: draft.quoteSource } : {}) };
}

export function composerDraftEqual(a: ComposerDraft | undefined, b: ComposerDraft | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.value !== b.value || (a.quotedText ?? '') !== (b.quotedText ?? '')) return false;
  if (JSON.stringify(a.quoteSource) !== JSON.stringify(b.quoteSource)) return false;
  if (a.mentions.length !== b.mentions.length) return false;
  return a.mentions.every((m, i) => {
    const n = b.mentions[i];
    return (
      m.start === n.start &&
      m.end === n.end &&
      m.kind === n.kind &&
      m.refId === n.refId &&
      m.label === n.label
    );
  });
}

/** `prefix` in front of the draft's text, its mention ranges moved along. */
export function prependToDraft<D extends { value: string; mentions: ReadonlyArray<{ start: number; end: number }> }>(
  prefix: string,
  draft: D,
): D {
  if (!prefix) return draft;
  return {
    ...draft,
    value: prefix + draft.value,
    mentions: draft.mentions.map((mention) => ({ ...mention, start: mention.start + prefix.length, end: mention.end + prefix.length })),
  };
}

/** A suggested prompt on a line of its own after what the draft holds. */
export function appendComposerLine<D extends { value: string; mentions: ReadonlyArray<{ start: number; end: number }> }>(
  draft: D,
  text: string,
): D {
  const requested = text.trim();
  if (!requested) return draft;
  const kept = draft.value.trimEnd();
  return {
    ...draft,
    value: kept ? `${kept}\n${requested}` : requested,
    mentions: draft.mentions.filter((mention) => mention.end <= kept.length),
  };
}

/**
 * An unsent message (a rejected send, a dequeued one) back in the composer,
 * in front of what the user has typed since. Both quotes stay; one quote chip
 * cannot carry two sources, so a restored quote from another source is framed
 * into the text instead.
 */
export function mergeComposerDraft(restored: ComposerDraft | null, current: ComposerDraft | null | undefined): ComposerDraft | null {
  const incoming = normalizeComposerDraft(restored);
  const kept = normalizeComposerDraft(current ?? null);
  if (!incoming || !kept) return incoming ?? kept;
  const distinctSources = incoming.quotedText && kept.quotedText
    && JSON.stringify(incoming.quoteSource) !== JSON.stringify(kept.quoteSource);
  const front = distinctSources
    ? prependToDraft(`${formatQuotedSelectionContext(incoming.quotedText!, incoming.quoteSource)}\n\n`, incoming)
    : incoming;
  const separator = front.value && kept.value ? '\n\n' : '';
  const back = prependToDraft(front.value + separator, kept);
  const quotedText = distinctSources ? kept.quotedText
    : [incoming.quotedText, kept.quotedText].filter(Boolean).join('\n\n') || undefined;
  const quoteSource = distinctSources ? kept.quoteSource
    : incoming.quotedText ? incoming.quoteSource : kept.quoteSource;
  return {
    value: back.value,
    mentions: [...front.mentions, ...back.mentions],
    quotedText,
    ...(quotedText && quoteSource ? { quoteSource } : {}),
  };
}
