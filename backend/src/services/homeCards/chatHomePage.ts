import { getDb } from '../db';

/**
 * The Page saved as the owner's Chat Home content, whatever the content mode: a hidden page or restored cards
 * keep it saved, and it stays out of automatic page maintenance. A leaf module, so pages code can ask without
 * importing the Home cards repository, which imports pages.
 */
export function savedChatHomePageId(ownerUserId: string): string | null {
  const row = getDb().prepare("SELECT json_extract(preferences,'$.pageId') AS page_id FROM home_customization WHERE owner_user_id=?")
    .get(ownerUserId) as { page_id: unknown } | undefined;
  return typeof row?.page_id === 'string' ? row.page_id : null;
}
