import { createElement, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { toast } from 'sonner';

interface NotificationCard {
  title: string;
  body?: string;
  duration: number;
  /** Clicking the card (or Enter/Space on it) dismisses it and runs this.
   *  Without it the toast is plain text. */
  onClick?: () => void;
  /** Sonner id, so the caller can dismiss this toast later. */
  id?: string;
  /** Exposed on a clickable card as data-attention-kind. */
  kind?: string;
  /** The toast went away by itself: timed out, swiped or closed. */
  onClose?: () => void;
}

export function dismissNotificationCard(id: string): void {
  toast.dismiss(id);
}

/** An in-app toast; with `onClick`, the whole card is a button. */
export function showNotificationCard({ title, body, duration, onClick, id, kind, onClose }: NotificationCard): void {
  const options = {
    duration,
    ...(id !== undefined ? { id } : {}),
    ...(onClose ? { onAutoClose: onClose, onDismiss: onClose } : {}),
  };
  if (!onClick) {
    toast(title, { ...options, description: body });
    return;
  }
  // sonner 1.7.4 has no whole-toast onClick (only close/cancel/action button
  // callbacks), so click-anywhere-to-navigate has to be a custom toast: an
  // interactive card whose root element owns the click and dismisses itself.
  const open = (toastId: string | number) => {
    toast.dismiss(toastId);
    onClick();
  };
  toast.custom(
    (toastId) =>
      createElement(
        'div',
        {
          role: 'button',
          tabIndex: 0,
          className: 'app-toast-card',
          'data-attention-kind': kind,
          onClick: () => open(toastId),
          onKeyDown: (e: ReactKeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              open(toastId);
            }
          },
        },
        createElement('div', { className: 'app-toast-card__title' }, title),
        body ? createElement('div', { className: 'app-toast-card__body' }, body) : null,
      ),
    options,
  );
}
