import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PaneTabStrip from './PaneTabStrip';

const actions = vi.hoisted(() => ({ focusPane: vi.fn() }));
vi.mock('../../state/chatStore', () => ({
  shallowArrayEqual: (a: unknown[], b: unknown[]) => a.length === b.length && a.every((value, i) => value === b[i]),
  useChatActions: () => ({ focusPane: actions.focusPane, closePane: () => {}, reorderPane: () => {} }),
  useChatPanes: () => ({ tabPanes: ['a', 'b', 'c'], focusedPane: 'a', paneItems: {} }),
  useStructuralSelector: (select: (nodes: Record<string, unknown>) => unknown) => select({
    a: { nodeId: 'a', title: 'Alpha' },
    b: { nodeId: 'b', title: 'Beta' },
    c: { nodeId: 'c', title: 'Gamma' },
  }),
}));
vi.mock('../../state/closeOtherPanes', () => ({
  useCloseOtherPanes: () => ({ closeOtherPanes: () => {}, canCloseOtherPanes: () => true }),
}));
vi.mock('./PaneLauncher', () => ({ default: () => null }));

beforeEach(() => {
  actions.focusPane.mockClear();
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
});

describe('PaneTabStrip', () => {
  it('is one Tab stop whose arrows, Home and End select a pane and keep the focus on its tab', () => {
    render(<PaneTabStrip leftInset={0} />);
    const [alpha, beta, gamma] = screen.getAllByRole('tab');
    expect([alpha.tabIndex, beta.tabIndex, gamma.tabIndex]).toEqual([0, -1, -1]);

    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(actions.focusPane).toHaveBeenLastCalledWith('b');
    expect(document.activeElement).toBe(beta);
    fireEvent.keyDown(beta, { key: 'End' });
    expect(actions.focusPane).toHaveBeenLastCalledWith('c');
    expect(document.activeElement).toBe(gamma);
    fireEvent.keyDown(gamma, { key: 'ArrowRight' });
    expect(actions.focusPane).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    expect(actions.focusPane).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(gamma, { key: 'Home' });
    expect(actions.focusPane).toHaveBeenLastCalledWith('a');
    expect(document.activeElement).toBe(alpha);
  });
});
