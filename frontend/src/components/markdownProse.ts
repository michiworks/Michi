import type React from 'react';
import type { MarkdownFeatureProfile } from './MarkdownContent';

/** Markdown written by agents or other apps: opening it loads nothing, and only https links stay links. */
export const UNTRUSTED_MARKDOWN: MarkdownFeatureProfile = { remoteMedia: false, httpsLinksOnly: true };

/**
 * Prose in the terminal palette. Typography's own --tw-prose-* colours win
 * over index.css's remap, so paragraphs, list items, bold, links, inline code
 * and h1-h4 are restated here.
 */
export const TERM_PROSE_CLASS =
  'prose prose-sm max-w-none wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 ' +
  '[&_p]:text-(--term-mid) [&_li]:text-(--term-mid) [&_strong]:text-(--term-fg) ' +
  '[&_a]:text-(--term-accent) [&_code]:text-(--term-fg) ' +
  '[&_h1]:text-(--term-fg) [&_h2]:text-(--term-fg) [&_h3]:text-(--term-fg) [&_h4]:text-(--term-fg)';

/** Reading prose in the message font. One object for every render, so MarkdownContent's memo holds. */
export const MESSAGE_PROSE_STYLE: React.CSSProperties = {
  color: 'var(--term-mid)',
  fontFamily: 'var(--message-latin-font), var(--message-cjk-font)',
  fontSize: 'var(--fs-lg)',
  lineHeight: 1.68,
};

/** Size, colour and font come from the surrounding text; the prose wrapper only draws the inline marks. */
export const INHERIT_PROSE_STYLE: React.CSSProperties = { color: 'inherit', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit' };
