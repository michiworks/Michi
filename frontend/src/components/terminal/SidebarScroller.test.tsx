import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { SidebarScroller } from './SidebarScroller';

afterEach(cleanup);

function mountList(scrollKey?: string) {
  const { container, unmount } = render(
    <SidebarScroller scrollKey={scrollKey}>
      <div style={{ height: 2000 }} />
    </SidebarScroller>,
  );
  return { view: container.querySelector('.sb-scroller__view') as HTMLElement, unmount };
}

describe('SidebarScroller', () => {
  it('reopens a keyed list where it was left', () => {
    const first = mountList('reopen');
    first.view.scrollTop = 640;
    fireEvent.scroll(first.view);
    first.unmount();

    expect(mountList('reopen').view.scrollTop).toBe(640);
  });

  it('starts an unkeyed list at the top', () => {
    const first = mountList();
    first.view.scrollTop = 640;
    fireEvent.scroll(first.view);
    first.unmount();

    expect(mountList().view.scrollTop).toBe(0);
  });
});
