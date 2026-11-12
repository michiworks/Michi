import type { CompanionItemDto } from 'michi-shared';
import { parseAssistantLink, type AssistantLink } from '../assistant/assistantLinks';

/**
 * What a link in the Companion's conversation may be (DESIGN R2.1). Its
 * replies draw on untrusted material (mail previews, CR titles, worker
 * replies), so only these render as links: Michi's own `michi://` links, the
 * work sites it watches, and the targets of its own feed items. Anything
 * else shows as plain text.
 */
export const COMPANION_LINK_HOSTS: readonly string[] = Object.freeze([
  'reviews.example.com',
  'builds.example.com',
  'outlook.office.com',
  'outlook.office365.com',
]);

export type CompanionLinkVerdict =
  | { kind: 'michi'; link: AssistantLink }
  | { kind: 'web'; url: string }
  | { kind: 'text' };

export function companionLinkVerdict(href: string, itemUrls: ReadonlySet<string>): CompanionLinkVerdict {
  const value = href.trim();
  const michi = parseAssistantLink(value);
  if (michi) return { kind: 'michi', link: michi };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'text' };
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return { kind: 'text' };
  if (itemUrls.has(url.href) || itemUrls.has(value)) return { kind: 'web', url: url.href };
  if (url.protocol === 'https:' && COMPANION_LINK_HOSTS.includes(url.hostname.toLowerCase())) return { kind: 'web', url: url.href };
  return { kind: 'text' };
}

/** The `url` targets of these items, the exact links the Companion may point at besides the work sites. */
export function companionItemUrls(items: readonly Pick<CompanionItemDto, 'target'>[]): ReadonlySet<string> {
  const urls = new Set<string>();
  for (const item of items) {
    if (item.target?.kind !== 'url') continue;
    urls.add(item.target.url);
    try { urls.add(new URL(item.target.url).href); } catch { /* not a URL: the exact string only */ }
  }
  return urls;
}
