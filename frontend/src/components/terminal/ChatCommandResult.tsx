import { useEffect } from 'react';
import type { ChatNodeState } from '../../state/chatTypes';

/** How long a completed command's result stays above the composer. */
export const COMMAND_RESULT_DISMISS_MS = 4000;

/** Session controls have visible results, but do not create model turns.
 *  A completed result goes after a moment; a failure stays until dismissed. */
export function ChatCommandResult({ result, onDismiss }: {
  result: NonNullable<ChatNodeState['commandResult']>;
  onDismiss: () => void;
}) {
  useEffect(() => {
    if (result.status !== 'completed') return;
    const timer = setTimeout(onDismiss, COMMAND_RESULT_DISMISS_MS);
    return () => clearTimeout(timer);
    // onDismiss is a fresh closure each render; the timer follows the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  return (
    <details key={`${result.command}:${result.status}`} open className="relative rounded border border-line bg-surface text-fg" aria-busy={result.status === 'running'}>
      <summary className="cursor-pointer px-3 py-2 pr-8 text-xs select-none">
        /{result.command}{result.status === 'running' ? ' · Running' : result.status === 'error' ? ' · Failed' : ''}
      </summary>
      {result.status !== 'running' && (
        <button type="button" aria-label="Dismiss" onClick={onDismiss}
          className="absolute right-1.5 top-1.5 rounded px-1.5 text-xs leading-5 text-fg-muted hover:text-fg">
          ×
        </button>
      )}
      <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-words px-3 pb-3 text-xs">{result.message}</pre>
    </details>
  );
}
