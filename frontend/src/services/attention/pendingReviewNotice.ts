import { toast } from 'sonner';
import { attentionAllowed } from './policy';

/**
 * A notice that something waits for the user in Settings (Memory's
 * confirmations, the Meta agent's tool approvals): one toast per id, replaced
 * as more arrive, withdrawn once nothing waits. The Settings badge counts the
 * same things, so the notice is only a heads-up and follows the Notifications
 * setting like an agent asking for input.
 */
export interface PendingReviewNotice {
  id: string;
  title: string;
  description: string;
  /** Opens the Settings section; without one the notice has no Review button. */
  onReview?: (() => void) | null;
  /** The user closed it or it timed out. */
  onClose?: () => void;
}

const DURATION_MS = 12_000;

/** Shows the notice unless the Notifications setting is off; true when it showed. */
export function showPendingReviewNotice(notice: PendingReviewNotice): boolean {
  if (!attentionAllowed('needs_input')) return false;
  const { onReview, onClose } = notice;
  toast(notice.title, {
    id: notice.id,
    description: notice.description,
    duration: DURATION_MS,
    ...(onClose ? { onDismiss: onClose, onAutoClose: onClose } : {}),
    ...(onReview ? { action: { label: 'Review', onClick: onReview } } : {}),
  });
  return true;
}

export function withdrawPendingReviewNotice(id: string): void {
  toast.dismiss(id);
}
