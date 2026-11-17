import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FormField } from 'michi-shared';
import { MichiBlock } from './MichiBlock';
import { answerOf, blankValue } from './vendor-blocks/src/desk/blocks/catalog/interactive/FieldControl';

afterEach(cleanup);
// Mantine's autosizing textarea listens for web fonts loading, which jsdom does not have.
beforeAll(() => {
  if (!document.fonts) Object.defineProperty(document, 'fonts', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
});

const form = (fields: unknown[]) => ({ id: 'f', type: 'form', title: 'Trip', prompt: 'Plan it', fields });
const sent = (requestAssistant: ReturnType<typeof vi.fn>) => JSON.parse(String(requestAssistant.mock.calls.at(-1)?.[1]).split('\n\n')[1]);

describe('form fields', () => {
  it('starts every field at its default and sends typed values', () => {
    const requestAssistant = vi.fn(() => true);
    render(<MichiBlock ctx={{ depth: 0, requestAssistant }} block={form([
      { key: 'city', label: 'City', type: 'text', default: 'Kyoto', help: 'Where you land' },
      { key: 'notes', label: 'Notes', type: 'textarea', default: 'Quiet\nhotel' },
      { key: 'nights', label: 'Nights', type: 'number', min: 1, max: 30, unit: 'nights', default: 3 },
      { key: 'budget', label: 'Budget', type: 'slider', min: 0, max: 5000, step: 100, unit: 'USD', default: 1500 },
      { key: 'seat', label: 'Seat', type: 'select', options: ['Aisle', 'Window'], default: 'Window' },
      { key: 'meals', label: 'Meals', type: 'multiselect', options: ['Breakfast', 'Lunch', 'Dinner'], default: ['Dinner', 'Breakfast'] },
      { key: 'day', label: 'Day', type: 'date', default: '2026-11-20' },
      { key: 'at', label: 'At', type: 'time', default: '09:30' },
      { key: 'insured', label: 'Insurance', type: 'checkbox', default: true },
    ])} />);
    expect(screen.getByText('Where you land')).toBeTruthy();
    expect(screen.getByText('1500 USD')).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Budget' }).getAttribute('aria-valuenow')).toBe('1500');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(sent(requestAssistant)).toEqual({
      city: 'Kyoto', notes: 'Quiet\nhotel', nights: 3, budget: 1500, seat: 'Window',
      // In the order the options are listed, not the order they were picked.
      meals: ['Breakfast', 'Dinner'], day: '2026-11-20', at: '09:30', insured: true,
    });
  });

  it('sends empty optional fields as null, and stops on a required one', async () => {
    const requestAssistant = vi.fn(() => true);
    render(<MichiBlock ctx={{ depth: 0, requestAssistant }} block={form([
      { key: 'at', label: 'At', type: 'time' },
      { key: 'meals', label: 'Meals', type: 'multiselect', options: ['Breakfast', 'Dinner'], required: true },
      { key: 'n', label: 'N', type: 'number' },
    ])} />);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(requestAssistant).not.toHaveBeenCalled();
    expect(screen.getByText('Choose at least one')).toBeTruthy();
    fireEvent.click(screen.getByRole('combobox', { name: /Meals/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Dinner' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(sent(requestAssistant)).toEqual({ at: null, meals: ['Dinner'], n: null });
  });

  it('sends a typed time and a zero', () => {
    const requestAssistant = vi.fn(() => true);
    render(<MichiBlock ctx={{ depth: 0, requestAssistant }} block={form([
      { key: 'at', label: 'At', type: 'time' },
      { key: 'n', label: 'N', type: 'number', required: true },
    ])} />);
    // A 24-hour clock in two boxes, whatever the browser's locale.
    fireEvent.change(screen.getByLabelText('At, hours'), { target: { value: '18' } });
    fireEvent.change(screen.getByLabelText('At, minutes'), { target: { value: '45' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'N' }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(sent(requestAssistant)).toEqual({ at: '18:45', n: 0 });
  });

  it('reads a stored field the write schema would refuse as the nearest control it can draw', () => {
    const requestAssistant = vi.fn(() => true);
    render(<MichiBlock ctx={{ depth: 0, requestAssistant }} block={form([
      // No range to slide over: a number box. A default outside the options is left out.
      { key: 'b', label: 'Budget', type: 'slider', min: 5 },
      { key: 's', label: 'Seat', type: 'select', options: ['Aisle'], default: 'Window' },
    ])} />);
    expect(screen.queryByRole('slider')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Budget' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(sent(requestAssistant)).toEqual({ b: null, s: null });
  });
});

describe('answerOf', () => {
  const field = (type: FormField['type'], extra: Partial<FormField> = {}): FormField => ({ key: 'k', label: 'L', type, ...extra });
  it('turns what a control holds into the value its field sends', () => {
    expect(answerOf(field('number'), '1.')).toBe(1);
    expect(answerOf(field('number'), '-')).toBeNull();
    expect(answerOf(field('number'), blankValue(field('number')))).toBeNull();
    expect(answerOf(field('slider', { min: 2, max: 4 }), blankValue(field('slider', { min: 2, max: 4 })))).toBe(2);
    expect(answerOf(field('text'), '  hi ')).toBe('hi');
    expect(answerOf(field('select', { options: ['a'] }), 'gone')).toBeNull();
    expect(answerOf(field('multiselect', { options: ['a', 'b', 'c'] }), ['c', 'x', 'a'])).toEqual(['a', 'c']);
    expect(answerOf(field('date'), '2026-02-30')).toBeNull();
    expect(answerOf(field('time'), '7:05')).toBeNull();
    expect(answerOf(field('time'), '07:05')).toBe('07:05');
    expect(answerOf(field('checkbox'), null)).toBe(false);
  });
});
