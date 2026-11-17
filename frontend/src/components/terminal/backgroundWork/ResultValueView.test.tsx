import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ResultValueView } from './ResultValueView';
import { readResultValue } from './resultValue';

function view(text: string) {
  render(<ResultValueView result={readResultValue(text)!} cutNote="The run keeps the first part." />);
  return screen.getByTestId('result-value');
}

describe('ResultValueView', () => {
  it('turns records into cards: ref and title, chips, counts, fields, then text', () => {
    const root = view(JSON.stringify({
      findings: [
        { id: 'F1', title: 'Stale cache', severity: 'high', files: 2, merged: true, commit: '03d2a9a6', problem: 'The cache keeps the previous answer after a write, so a reader that arrives within the window sees data that is already gone.' },
        { id: 'F2', title: 'Typo', severity: 'low' },
      ],
    }));
    expect(root.textContent).toContain('Findings · 2');
    const [first, second] = within(root).getAllByTestId('result-record');
    expect(first.textContent).toMatch(/^F1Stale cachehigh2 files·✓ merged/);
    expect(within(first).getByText('high').style.color).toBe('var(--term-danger-text)');
    expect(within(second).getByText('low').style.color).toBe('var(--term-mid)');
    expect(within(first).getByText('Commit').nextElementSibling?.textContent).toBe('03d2a9a6');
    expect(within(first).getByText('Problem').nextElementSibling?.textContent).toMatch(/^The cache keeps/);
  });

  it('shows records of a few short fields as a table and plain text as written', () => {
    const root = view(JSON.stringify({
      verifiedTotals: [{ id: 'C-tokens', confirmed: 2 }, { id: 'C-motion', confirmed: 0 }],
      notes: ['Kept --term-pane-*, --term-sidebar-* as they are.'],
    }));
    expect(root.textContent).toContain('Verified totals · 2');
    expect(within(root).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['ID', 'Confirmed']);
    expect(within(root).getAllByRole('row')).toHaveLength(3);
    // A lone "*" is not emphasis: the note reads as the agent wrote it.
    expect(root.querySelector('em')).toBeNull();
    expect(within(root).getByRole('listitem').textContent).toBe('Kept --term-pane-*, --term-sidebar-* as they are.');
  });

  it('counts what a shortened list left out and says so after it', () => {
    const root = view(JSON.stringify({ totals: [{ id: 'C-tokens', confirmed: 2 }, { id: 'C-motion', confirmed: 0 }, '… 3 more'] }));
    expect(root.textContent).toContain('Totals · 5');
    expect(within(root).getAllByRole('row')).toHaveLength(3);
    expect(within(root).getByTestId('result-omitted').textContent).toBe('⋯ 3 more not kept');
  });

  it('says once where a cut result ends, counting its open lists as lower bounds', () => {
    const notes = JSON.stringify(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.', 'Seven.', 'Eight.', 'Nine.']);
    const root = view(`{"docs": [{"file": "/tmp/out/tokens.md", "rules": 34, "notes": ${notes}}, {"file": "/tmp/out/motion.md", "notes": ["Appl…`);
    expect(root.textContent).toContain('Docs · 2+');
    const [tokens, motion] = within(root).getAllByTestId('result-record');
    expect(within(tokens).getByTitle('/tmp/out/tokens.md').textContent).toBe('tokens.md');
    expect(tokens.textContent).toContain('34 rules');
    expect(within(tokens).getAllByRole('listitem')).toHaveLength(8);
    fireEvent.click(within(tokens).getByRole('button', { name: 'Show 1 more' }));
    expect(within(tokens).getAllByRole('listitem')).toHaveLength(9);
    expect(motion.textContent).toContain('Notes · 1+');
    expect(within(motion).getByRole('listitem').textContent).toBe('Appl…');
    expect(within(root).getAllByTestId('result-cut')).toHaveLength(1);
    expect(within(motion).getByTestId('result-cut').textContent).toBe('⋯ Cut off here. The run keeps the first part.');
  });
});
