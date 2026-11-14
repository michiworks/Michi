import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsToc } from './SettingsToc';

// jsdom lays nothing out: each test says how tall the page is and where its groups sit.
const layout = vi.hoisted(() => ({ windowWidth: 1080, scrollHeight: 3800, clientHeight: 700, tops: {} as Record<string, number> }));

function Page({ titles }: { titles: string[] }) {
  const ref = useRef<HTMLElement>(null);
  return (
    <div data-testid="window">
      <section ref={ref} data-testid="page">
        {titles.map((title) => (
          <section key={title} data-title={title}><h2 className="settings-section__title">{title}</h2></section>
        ))}
      </section>
      <SettingsToc contentRef={ref} />
    </div>
  );
}

function stubLayout() {
  const sizes = (el: Element, key: 'clientWidth' | 'scrollHeight' | 'clientHeight') => {
    const id = (el as HTMLElement).dataset?.testid;
    if (key === 'clientWidth') return id === 'window' ? layout.windowWidth : 0;
    if (id !== 'page') return 0;
    return key === 'scrollHeight' ? layout.scrollHeight : layout.clientHeight;
  };
  for (const key of ['clientWidth', 'scrollHeight', 'clientHeight'] as const) {
    vi.spyOn(HTMLElement.prototype, key, 'get').mockImplementation(function (this: HTMLElement) { return sizes(this, key); });
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const page = document.querySelector<HTMLElement>('[data-testid="page"]')!;
    const top = this.dataset.title ? layout.tops[this.dataset.title] - page.scrollTop : 0;
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) };
  });
}

async function frame() { await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(null))); }); }

beforeEach(() => {
  layout.windowWidth = 1080;
  layout.scrollHeight = 3800;
  layout.clientHeight = 700;
  layout.tops = { Name: 0, Model: 900, Watching: 2000, Writing: 3300 };
  stubLayout();
});
afterEach(() => { vi.restoreAllMocks(); });

describe('SettingsToc', () => {
  it('lists a long page’s groups, marks the one in view, and scrolls to the one chosen', async () => {
    render(<Page titles={['Name', 'Model', 'Watching', 'Writing']} />);
    await frame();
    const nav = screen.getByRole('navigation', { name: 'On this page' });
    const items = Array.from(nav.querySelectorAll('button')).map((button) => button.textContent);
    expect(items).toEqual(['Name', 'Model', 'Watching', 'Writing']);
    expect(screen.getByRole('button', { name: 'Name' }).getAttribute('aria-current')).toBe('location');

    const page = screen.getByTestId('page');
    page.scrollTo = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: 'Watching' }));
    expect(page.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1990 }));

    Object.defineProperty(page, 'scrollTop', { configurable: true, value: 1000 });
    fireEvent.scroll(page);
    expect(screen.getByRole('button', { name: 'Model' }).getAttribute('aria-current')).toBe('location');
    expect(screen.getByRole('button', { name: 'Name' }).hasAttribute('aria-current')).toBe(false);
  });

  it('stays out of a page that two screens hold, and of a narrow window', async () => {
    layout.scrollHeight = 1300;
    const view = render(<Page titles={['Name', 'Model', 'Watching', 'Writing']} />);
    await frame();
    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
    view.unmount();
    layout.scrollHeight = 3800;
    layout.windowWidth = 900;
    render(<Page titles={['Name', 'Model', 'Watching', 'Writing']} />);
    await frame();
    expect(screen.queryByRole('navigation', { name: 'On this page' })).toBeNull();
  });
});
