import type { UsePageResult } from '../../../state/pages/usePage';
import type { ChangeCardProps } from './ChangeCard';

type ChangeHandlers = Pick<ChangeCardProps, 'onAccept' | 'onDismiss' | 'onReopen' | 'onRevert' | 'onRedo'>;

/**
 * A page's change cards' actions. Each hands back its promise: a card waits on
 * it, and an answered suggestion takes its buttons back as soon as the answer
 * settles without taking, not after the card's fallback for a handler that
 * gives nothing to wait on.
 */
export function pageChangeHandlers(page: Pick<UsePageResult, 'accept' | 'dismiss' | 'reopen' | 'revert' | 'redo'>): ChangeHandlers {
  return {
    onAccept: (change, edited) => page.accept(change.id, edited),
    onDismiss: (change) => page.dismiss(change.id),
    onReopen: (change) => page.reopen(change.id),
    onRevert: (change) => page.revert(change.id),
    onRedo: (change) => page.redo(change.id),
  };
}
