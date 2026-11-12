import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealPageTarget } from './revealPageTarget';

function el(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  for (const node of Array.from(host.querySelectorAll<HTMLElement>('*'))) node.scrollIntoView = vi.fn();
  return host;
}
const scrolled = (id: string) => (document.getElementById(id)!.scrollIntoView as ReturnType<typeof vi.fn>);

describe('revealPageTarget', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    delete document.documentElement.dataset.reduceMotion;
  });

  it('waits for the page to render the block, scrolls to it and flashes it once, never inside the chat window', () => {
    revealPageTarget({ targetId: 'b-1' });
    vi.advanceTimersByTime(3_000);
    el('<section class="meta-chat-panel"><div class="michi-doc-block" id="in-window" data-block-id="b-1"></div></section>'
      + '<div class="michi-doc-block" id="on-page"><div data-block-id="b-1"></div></div>');
    vi.advanceTimersByTime(100);
    const block = document.getElementById('on-page')!;
    expect(block.hasAttribute('data-reveal-flash')).toBe(true);
    expect(scrolled('on-page')).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth', block: 'center' }));
    expect(document.getElementById('in-window')!.hasAttribute('data-reveal-flash')).toBe(false);
    vi.advanceTimersByTime(1_600);
    expect(block.hasAttribute('data-reveal-flash')).toBe(false);
  });

  it('jumps instead of scrolling smoothly when motion is reduced', () => {
    document.documentElement.dataset.reduceMotion = 'on';
    el('<div class="michi-doc-block" id="b" data-block-id="b-1"></div>');
    revealPageTarget({ targetId: 'b-1' });
    expect(scrolled('b')).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });

  it('in a page pane finds only that page\'s block, row or whole database; a row does not flash', () => {
    const pane = { pageId: 'page-1', workspaceId: 'ws', backendConnectionId: 'local' };
    el('<div data-native-page-pane data-page-id="page-2" data-workspace-id="ws" data-backend-connection-id="local"><div class="michi-doc-block" id="other" data-block-id="b-1"></div></div>'
      + '<div data-native-page-pane data-page-id="page-1" data-workspace-id="ws" data-backend-connection-id="local">'
      + '<div class="michi-doc-block" id="mine" data-block-id="b-1"></div>'
      + '<div data-native-database data-database-id="db-1" id="db"><div data-row-id="r-1" id="row"></div></div></div>');
    revealPageTarget({ targetId: 'b-1', pane });
    expect(scrolled('mine')).toHaveBeenCalled();
    expect(scrolled('other')).not.toHaveBeenCalled();
    revealPageTarget({ targetId: 'r-1', databaseId: 'db-1', pane });
    expect(scrolled('row')).toHaveBeenCalled();
    revealPageTarget({ targetId: 'db-1', databaseId: 'db-1', pane });
    expect(scrolled('db')).toHaveBeenCalled();
    expect(document.getElementById('row')!.hasAttribute('data-reveal-flash')).toBe(false);
  });

  it('a newer reveal replaces one still waiting, and a reveal gives up after its wait', () => {
    revealPageTarget({ targetId: 'first' });
    revealPageTarget({ targetId: 'second' }, 1_000);
    el('<div class="michi-doc-block" id="first" data-block-id="first"></div>');
    vi.advanceTimersByTime(200);
    expect(scrolled('first')).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    el('<div class="michi-doc-block" id="second" data-block-id="second"></div>');
    vi.advanceTimersByTime(200);
    expect(scrolled('second')).not.toHaveBeenCalled();
  });
});
