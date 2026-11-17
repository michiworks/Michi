import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import MoveThreadDialog from './MoveThreadDialog';

afterEach(cleanup);

it('keeps the row that ↓ highlights in view', () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  const targets = ['Alpha', 'Beta', 'Gamma'].map((name) => ({ id: name, name }));
  render(<MoveThreadDialog open threadLabel="Notes" targets={targets} onClose={vi.fn()} onPick={vi.fn()} />);

  const filter = screen.getByPlaceholderText('filter workspaces…');
  fireEvent.keyDown(filter, { key: 'ArrowDown' });
  fireEvent.keyDown(filter, { key: 'ArrowDown' });

  expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
  expect(scrollIntoView.mock.contexts.at(-1)).toBe(screen.getByRole('button', { name: /Gamma/ }).closest('li'));
});
