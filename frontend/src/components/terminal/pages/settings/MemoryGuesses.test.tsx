import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MemoryGuess } from 'michi-shared';
import { resetMemoryNotifications } from '../../../../state/memory/memoryNotifications';
import { MemoryGuesses } from './MemoryGuesses';

const backend = vi.hoisted(() => ({
  guesses: [] as MemoryGuess[],
  /** What confirm answers instead of a memory: an API error's code. */
  confirmError: null as string | null,
}));

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }) }));
vi.mock('../../../../services/api/memories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../services/api/memories')>();
  return {
    ...actual,
    fetchMemoryGuesses: vi.fn(async () => structuredClone(backend.guesses)),
    confirmMemoryGuess: vi.fn(async (id: string) => {
      if (backend.confirmError) throw new actual.MemoryApiError(409, 'no', { code: backend.confirmError });
      const guess = backend.guesses.find((entry) => entry.id === id)!;
      backend.guesses = backend.guesses.filter((entry) => entry.id !== id);
      return {
        id: 'mem-confirmed', ownerUserId: 'local', scope: { kind: 'user' }, kind: 'preference', body: guess.body, source: null, status: 'active',
        origin: 'explicit', version: 1, supersedesId: null, sourceRisk: null, createdAt: 1, updatedAt: 1,
      };
    }),
    rejectMemoryGuess: vi.fn(async (id: string) => { backend.guesses = backend.guesses.filter((entry) => entry.id !== id); }),
    subscribeMemoryChanges: () => () => {},
  };
});

import * as api from '../../../../services/api/memories';

const guess = (id: string, body: string): MemoryGuess => ({
  id, body, createdAt: 1,
  cites: [{ ref: 'm:1v1', id: 'mem-1', body: 'The user loves Sichuan hot pot.' }, { ref: 'm:2v1', id: 'mem-2', body: 'The user keeps chili oil at work.' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  resetMemoryNotifications();
  backend.guesses = [guess('mg-1', 'The user likes spicy food.'), guess('mg-2', 'The user eats lunch at their desk.')];
  backend.confirmError = null;
});
afterEach(() => {
  cleanup();
  resetMemoryNotifications();
});

describe('Settings › Memory › Guesses', () => {
  it('is collapsed, with no count, and absent while there is no guess', async () => {
    render(<MemoryGuesses memoryOn reloadKey={0} />);
    const section = await screen.findByRole('region', { name: 'Guesses' });
    const toggle = within(section).getByRole('button', { name: 'Show guesses' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(section).queryByRole('list', { name: 'Guesses' })).toBeNull();
    expect(section.textContent).not.toMatch(/\d/);
    cleanup();
    backend.guesses = [];
    render(<MemoryGuesses memoryOn reloadKey={0} />);
    await waitFor(() => expect(api.fetchMemoryGuesses).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: 'Guesses' })).toBeNull();
  });

  it('shows each guess with the memories it rests on and both answers, without hover', async () => {
    render(<MemoryGuesses memoryOn reloadKey={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show guesses' }));
    const list = screen.getByRole('list', { name: 'Guesses' });
    const first = within(list).getByText('The user likes spicy food.').closest('li')!;
    expect(within(first).getByRole('list', { name: 'Memories it’s based on' }).textContent).toContain('Sichuan hot pot');
    expect(within(first).getByRole('button', { name: 'That’s right' })).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Not true' })).toBeTruthy();
  });

  it('That’s right confirms it and Not true rejects it; each leaves the list, and the section goes with the last', async () => {
    render(<MemoryGuesses memoryOn reloadKey={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show guesses' }));
    const list = screen.getByRole('list', { name: 'Guesses' });
    fireEvent.click(within(within(list).getByText('The user likes spicy food.').closest('li')!).getByRole('button', { name: 'That’s right' }));
    await waitFor(() => expect(screen.queryByText('The user likes spicy food.')).toBeNull());
    expect(api.confirmMemoryGuess).toHaveBeenCalledWith('mg-1');
    fireEvent.click(within(screen.getByText('The user eats lunch at their desk.').closest('li')!).getByRole('button', { name: 'Not true' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Guesses' })).toBeNull());
    expect(api.rejectMemoryGuess).toHaveBeenCalledWith('mg-2');
  });

  it('says so when a guess no longer applies, and offers no confirm while memory is off', async () => {
    backend.confirmError = 'invalid_state';
    const { rerender } = render(<MemoryGuesses memoryOn reloadKey={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show guesses' }));
    const first = screen.getByText('The user likes spicy food.').closest('li')!;
    fireEvent.click(within(first).getByRole('button', { name: 'That’s right' }));
    expect((await within(first).findByRole('alert')).textContent).toBe('This guess no longer applies.');
    rerender(<MemoryGuesses memoryOn={false} reloadKey={0} />);
    const second = screen.getByText('The user eats lunch at their desk.').closest('li')!;
    expect((within(second).getByRole('button', { name: 'That’s right' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(second).getByRole('button', { name: 'Not true' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
