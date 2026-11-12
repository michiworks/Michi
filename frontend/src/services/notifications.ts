import { showOsNotification } from './attention/desktop';
import { showNotificationCard } from './attention/toast';

export interface NotifyOptions {
  title: string;
  body?: string;
  onClick?: () => void;
  /** One OS notification per key: a newer one for the same target replaces the older one. */
  key?: string;
}

let notifySequence = 0;

/**
 * Show an in-app toast now and, when the window is unfocused, an OS
 * notification whose click returns here and runs `onClick`. No policy:
 * callers that decide for themselves (scheduled runs, whose Electron main
 * owns delivery). Agent attention goes through attention/policy instead.
 */
export function notify({ title, body, onClick, key }: NotifyOptions): void {
  showNotificationCard({ title, body, duration: 4000, onClick });
  if (!document.hasFocus()) {
    showOsNotification({ key: key ?? `notify:${++notifySequence}`, title, body, onOpen: onClick });
  }
}
