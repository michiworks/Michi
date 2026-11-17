import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatNodeState } from '../../state/chatTypes';
import { DEFAULT_PREFS } from '../../state/prefs';
import { PaneMessageList } from './PaneMessageList';

vi.mock('../MarkdownContent', () => ({ default: ({ text }: { text: string }) => <span>{text}</span> }));

const node: ChatNodeState = {
  nodeId: 'node', kind: 'chat', chatId: 'chat', projectId: 'workspace', status: 'error', followUps: [],
  errorKind: 'turn_persistence_failed', errorTurnId: 'original-turn', error: 'Final save failed',
  messages: [
    { id: 'user', role: 'user', text: 'Update the file', toolCalls: [] },
    { id: 'assistant', role: 'assistant', text: 'The file was updated.', toolCalls: [] },
  ],
};

function list(value: ChatNodeState, onCheck = vi.fn(), onRunAgain = vi.fn()) {
  // In a pane with its composer, which takes focus when nothing else can.
  return <div className="terminal-pane">
    <PaneMessageList node={value} prefs={DEFAULT_PREFS} contentStyle={{}} streaming={false}
      onRetryTurn={onCheck} onRunAgain={onRunAgain}
      onEditUserMessage={vi.fn()} onContinueFollowUp={vi.fn()} onBranchFollowUp={vi.fn()} />
    <div className="terminal-composer"><div role="textbox" aria-label="Message" contentEditable suppressContentEditableWarning tabIndex={0} /></div>
  </div>;
}

/** Presses a button the way the keyboard does: focused first. */
function press(name: string | RegExp) {
  const button = screen.getByRole('button', { name });
  button.focus();
  fireEvent.click(button);
}

describe('uncertain turn recovery actions', () => {
  it('checks the original task and requires an explicit second action to run it again', () => {
    const check = vi.fn();
    const rerun = vi.fn();
    render(list(node, check, rerun));
    fireEvent.click(screen.getByRole('button', { name: 'Check original turn' }));
    expect(check).toHaveBeenCalledExactlyOnceWith(0);
    expect(rerun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Run again$/ }));
    expect(rerun).not.toHaveBeenCalled();
    expect(screen.getByText(/may repeat file changes/)).not.toBeNull();
    press('Run again anyway');
    expect(rerun).toHaveBeenCalledExactlyOnceWith(0);
    // The rerun takes the error row away: the composer has the keyboard.
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
    expect(screen.getByText('The file was updated.')).not.toBeNull();
  });

  it('updates the memoized error tail while checking and leaves an unavailable result visible', () => {
    const check = vi.fn();
    const rerun = vi.fn();
    const view = render(list(node, check, rerun));
    view.rerender(list({ ...node, errorRecovery: 'checking' }, check, rerun));
    expect((screen.getByRole('button', { name: 'Checking original turn…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^Run again$/ }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(list({ ...node, errorRecovery: 'unavailable' }, check, rerun));
    expect(screen.getByText(/original result could not be confirmed/)).not.toBeNull();
    expect(screen.getByText('The file was updated.')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Run again$/ }));
    press('Keep current result');
    expect(rerun).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Run again anyway' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Run again$/ }));
  });

  it('does not turn an ordinary rejected request into an unknown-outcome warning', () => {
    const check = vi.fn();
    render(list({ ...node, errorKind: 'invalid_request' }, check));
    fireEvent.click(screen.getByTestId('error-tail-retry'));
    expect(check).toHaveBeenCalledExactlyOnceWith(0);
    expect(screen.queryByRole('button', { name: 'Check original turn' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Run again$/ })).toBeNull();
  });

  it('offers one Resume for a turn a restart cut short, with the partial output kept', () => {
    const resume = vi.fn();
    const rerun = vi.fn();
    render(list({
      ...node, errorKind: 'backend_restarted', errorTurnId: 'cut-short',
      error: 'Michi restarted while this task was running. Review the partial output above, then resume.',
    }, resume, rerun));
    expect(screen.getByText('Turn interrupted')).not.toBeNull();
    expect(screen.getByText('The file was updated.')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Michi restarted while this task was running/);
    expect(screen.queryByRole('button', { name: 'Check original turn' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Run again$/ })).toBeNull();
    expect(screen.queryByText(/could not be confirmed/)).toBeNull();
    // The sentence is said once: the raw error line is not repeated below the status.
    expect(screen.getAllByText(/Michi restarted while this task was running/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(resume).toHaveBeenCalledExactlyOnceWith(0);
    expect(rerun).not.toHaveBeenCalled();
  });
});
