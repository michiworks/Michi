import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PermissionBanner from './PermissionBanner';

describe('PermissionBanner source label', () => {
  it.each([false, true])('preserves existing input focus when mounted (readOnly=%s)', (readOnly) => {
    const { rerender } = render(<><input aria-label="Message" />{null}</>);
    const input = screen.getByRole('textbox', { name: 'Message' });
    input.focus();
    rerender(<><input aria-label="Message" /><PermissionBanner
      permission={{ requestId: 1, title: 'Approve bash?', options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow Once' },
      ] }}
      onRespond={vi.fn()}
      readOnly={readOnly}
    /></>);
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole('status').textContent).toContain('Approve bash?');
    if (readOnly) {
      expect(screen.queryByRole('button')).toBeNull();
      expect(screen.getByRole('status').textContent).toContain('Viewing only');
    } else {
      const allow = screen.getByRole('button', { name: 'Allow Once' });
      expect(allow.tabIndex).toBe(0);
      allow.focus();
      expect(document.activeElement).toBe(allow);
    }
  });

  it('offers all four choices without approval shortcuts', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner permission={{ requestId: 4, title: 'shell', options: [
      { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
      { optionId: 'once', kind: 'allow_once', name: 'Allow Once' },
      { optionId: 'tool', kind: 'allow_always', name: 'Trust this tool' },
      { optionId: 'session', kind: 'allow_session', name: 'Trust all tools for this session' },
    ] }} onRespond={onRespond} />);
    for (const [name, id] of [['Deny', 'deny'], ['Allow Once', 'once'], ['Trust this tool', 'tool'], ['Trust all tools for this session', 'session']]) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(onRespond).toHaveBeenLastCalledWith(id);
    }
    onRespond.mockClear();
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(document, { key: 'Enter', metaKey: true, shiftKey: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('does not allow tool trust when no stable tool identity is available', () => {
    const onRespond = vi.fn();
    render(<PermissionBanner permission={{ requestId: 4, title: 'Run command', options: [
      { optionId: 'tool', kind: 'allow_always', name: 'Trust this tool', disabled: true },
    ] }} onRespond={onRespond} />);
    expect((screen.getByRole('button', { name: /^Trust this tool/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Trust this tool' }));
    expect(onRespond).not.toHaveBeenCalled();
  });
  it('names the answers of Michi\'s own prompts (Pi\'s follow-up approval), and keeps a runtime\'s by kind', () => {
    const onRespond = vi.fn();
    const { unmount } = render(<PermissionBanner permission={{ requestId: 5, title: 'Send a message to "Worker"?', source: 'michi_policy', options: [
      { optionId: 'reject_once', kind: 'reject_once', name: "Don't send" },
      { optionId: 'allow_once', kind: 'allow_once', name: 'Send' },
      { optionId: 'allow_always', kind: 'allow_always', name: 'Send, and stop asking for this conversation' },
    ] }} onRespond={onRespond} />);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(["Don't send", 'Send', 'Send, and stop asking for this conversation']);
    fireEvent.click(screen.getByRole('button', { name: 'Send, and stop asking for this conversation' }));
    expect(onRespond).toHaveBeenLastCalledWith('allow_always');
    unmount();

    // Michi's ordinary tool approval: a name that is only the kind's label in other case reads as the label.
    const ordinary = render(<PermissionBanner permission={{ requestId: 6, title: 'shell', source: 'michi_policy', options: [
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
    ] }} onRespond={vi.fn()} />);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Deny', 'Allow Once']);
    ordinary.unmount();

    // A runtime's own names stay by kind.
    render(<PermissionBanner permission={{ requestId: 7, title: 'Approve bash?', source: 'codex_approval', options: [
      { optionId: 'no', kind: 'reject_once', name: 'No, and tell Codex what to do differently' },
      { optionId: 'yes', kind: 'allow_once', name: 'Yes' },
    ] }} onRespond={vi.fn()} />);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Deny', 'Allow Once']);
  });

  it('renders Codex approval source', () => {
    render(
      <PermissionBanner
        permission={{
          requestId: 1,
          title: 'Approve bash?',
          options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
          source: 'codex_approval',
        }}
        onRespond={vi.fn()}
      />,
    );
    expect(screen.getByTestId('permission-source').textContent).toBe('Codex approval');
  });
});
