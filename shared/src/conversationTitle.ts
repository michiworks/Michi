/**
 * An untitled conversation's name from its first user message, as the sidebar
 * shows it until the agent titles it: a leading /btw or /branch, quoted lines
 * and extra whitespace go, and it is cut to `max` characters. Null when
 * nothing is left.
 */
export function deriveConversationTitle(userText: string | undefined | null, max = 50): string | null {
  if (!userText) return null;
  const txt = userText
    .replace(/^\s*\/(?:btw|branch)\s+/i, '')
    .replace(/^>.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!txt) return null;
  return txt.length > max ? txt.slice(0, max) + '…' : txt;
}
