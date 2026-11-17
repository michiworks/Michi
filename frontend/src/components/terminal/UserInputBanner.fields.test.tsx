import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import UserInputBanner, { ResolvedUserInput } from './UserInputBanner';
import type { UserInputRequest } from '../../state/chatTypes';

vi.mock('../../state/prefs', () => ({
  usePrefs: () => ({ prefs: { reduceMotion: false } }),
  usePagePalette: () => 'bone',
}));

afterEach(() => { vi.restoreAllMocks(); });

const request = (questions: UserInputRequest['questions']): UserInputRequest => ({ requestId: 1, questions, answers: [] });

describe('UserInputBanner form fields', () => {
  it('draws a number field in place of the options and sends its typed value with its text', async () => {
    const onSubmit = vi.fn();
    render(<UserInputBanner onSubmit={onSubmit} onSkip={vi.fn()} userInput={request([
      { question: 'How many nights?', options: [], multiSelect: false, field: { key: 'n', label: 'Nights', type: 'number', min: 1, unit: 'nights', required: true } },
    ])} />);
    const box = await screen.findByRole('textbox', { name: 'Nights' });
    expect(screen.queryByPlaceholderText(/Other/)).toBeNull();
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(box, { target: { value: '3' } });
    expect(submit).toHaveProperty('disabled', false);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith([{ question: 'How many nights?', answer: '3 nights', value: 3 }]);
  });

  it('starts at the default, moves through several field questions and submits them all', async () => {
    const onSubmit = vi.fn();
    render(<UserInputBanner onSubmit={onSubmit} onSkip={vi.fn()} userInput={request([
      { id: 'q1', question: 'Budget?', options: [], multiSelect: false, field: { key: 'b', label: 'Budget', type: 'slider', min: 0, max: 5000, step: 100, unit: 'USD', default: 1500 } },
      { id: 'q2', question: 'Leave at?', options: [], multiSelect: false, field: { key: 't', label: 'Time', type: 'time' } },
      { id: 'q3', question: 'Notes?', options: [], multiSelect: false, field: { key: 'x', label: 'Notes', type: 'text' } },
    ])} />);
    expect(await screen.findByText('1500 USD')).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Budget' }).getAttribute('aria-valuenow')).toBe('1500');
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    fireEvent.change(await screen.findByLabelText('Time, hours'), { target: { value: '09' } });
    fireEvent.change(screen.getByLabelText('Time, minutes'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    // An optional field may go empty.
    fireEvent.click(screen.getByRole('button', { name: /Submit all/ }));
    expect(onSubmit).toHaveBeenCalledWith([
      { id: 'q1', question: 'Budget?', answer: '1500 USD', value: 1500 },
      { id: 'q2', question: 'Leave at?', answer: '09:30', value: '09:30' },
      { id: 'q3', question: 'Notes?', answer: '', value: '' },
    ]);
  });

  it('keeps choice questions as they were next to a field question', async () => {
    const onSubmit = vi.fn();
    render(<UserInputBanner onSubmit={onSubmit} onSkip={vi.fn()} userInput={request([
      { question: 'Insured?', options: [], multiSelect: false, field: { key: 'i', label: 'Add insurance', type: 'checkbox' } },
      { question: 'Seat?', options: [{ label: 'Aisle' }, { label: 'Window' }], multiSelect: false },
    ])} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Add insurance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next →' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Window' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit all/ }));
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Insured?', answer: 'Yes', value: true },
      { question: 'Seat?', answer: 'Window' },
    ]);
  });

  it('shows a field answer in the receipt as text', () => {
    render(<ResolvedUserInput userInput={{ ...request([
      { question: 'How many nights?', options: [], multiSelect: false, field: { key: 'n', label: 'Nights', type: 'number', unit: 'nights' } },
    ]), resolved: true, answers: [{ question: 'How many nights?', answer: '3 nights', value: 3 }] }} />);
    expect(screen.getByText('3 nights')).toBeTruthy();
  });
});
