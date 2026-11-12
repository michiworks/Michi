import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SearchHighlight } from './SearchHighlight';

describe('SearchHighlight', () => {
  it('marks every match of the trimmed query, ignoring case', () => {
    const { container } = render(<p><SearchHighlight text="xFooy foo" query=" FOO " /></p>);
    expect([...container.querySelectorAll('mark')].map((mark) => [mark.textContent, mark.className]))
      .toEqual([['Foo', 'search-mark'], ['foo', 'search-mark']]);
    expect(container.textContent).toBe('xFooy foo');
  });

  it('leaves the text alone for a blank query', () => {
    const { container } = render(<p><SearchHighlight text="Foo" query="  " /></p>);
    expect(container.querySelector('mark')).toBeNull();
  });
});
