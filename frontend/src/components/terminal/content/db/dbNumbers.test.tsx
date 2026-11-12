import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MichiDbColumn } from 'michi-shared';

// The formatters are made when their modules load, so the browser locale must be German before the imports.
vi.hoisted(() => {
  const NumberFormat = Intl.NumberFormat;
  Intl.NumberFormat = function (locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    return new NumberFormat(locales ?? 'de-DE', options);
  } as typeof Intl.NumberFormat;
});

import { CellView } from './CellView';
import { groupSums } from './views/RowBits';
import { userDatabase } from './dbTestData';

describe('database numbers', () => {
  const hours: MichiDbColumn = { id: 'c_hours', name: 'Hours', type: 'number' };

  it('are written as page blocks write them, whatever the browser locale', () => {
    const db = userDatabase();
    const { container } = render(<CellView db={db} column={hours} value={1234.5} />);
    expect(container.textContent).toBe('1,234.5');
    const group = { key: 'all', label: 'All', rows: [{ ...db.rows[0], values: { c_hours: 1234.5 } }], count: 1, sums: { c_hours: 1234.5 } };
    expect(groupSums({ ...db, columns: [...db.columns, hours] }, group, [hours], ['c_hours'])).toEqual(['Hours 1,234.5']);
  });
});
