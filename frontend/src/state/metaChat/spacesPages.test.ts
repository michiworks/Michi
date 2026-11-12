import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSpacesHomeIds, loadSpacesHomeIds, openSpacesPage, PAGE_DELETED_MESSAGE, resetSpacesPagesForTests } from './spacesPages';
import { OPEN_NATIVE_PAGE_EVENT } from '../../components/terminal/spaces/SpacesPage';
import { PageApiError } from '../../services/api/pages';
import { OPEN_WORKSPACE_HOME_EVENT } from '../pages/workspaceHomeNav';

const toast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const fetchPage = vi.hoisted(() => vi.fn());
vi.mock('../../services/api/pages', async () => {
  const actual = await vi.importActual<typeof import('../../services/api/pages')>('../../services/api/pages');
  return { ...actual, fetchPage };
});

const events: Array<{ type: string; detail: unknown }> = [];
const record = (event: Event) => events.push({ type: event.type, detail: (event as CustomEvent).detail });

beforeEach(() => {
  events.length = 0;
  toast.mockClear();
  fetchPage.mockReset();
  window.addEventListener(OPEN_NATIVE_PAGE_EVENT, record);
  window.addEventListener('michi:nav-page', record);
  window.addEventListener(OPEN_WORKSPACE_HOME_EVENT, record);
});
afterEach(() => {
  window.removeEventListener(OPEN_NATIVE_PAGE_EVENT, record);
  window.removeEventListener('michi:nav-page', record);
  window.removeEventListener(OPEN_WORKSPACE_HOME_EVENT, record);
  resetSpacesPagesForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('openSpacesPage', () => {
  it("opens a page in its own workspace, the Home in place of its page, and only scrolls for the page on screen", async () => {
    fetchPage.mockResolvedValue({ id: 'pg-r', workspaceId: 'ws-r' });
    resetSpacesPagesForTests({ home: { id: 'pg-home', title: 'Home' }, workspaces: {} });
    expect(await openSpacesPage({ pageId: 'pg-r' })).toBe('opened');
    expect(await openSpacesPage({ pageId: 'pg-home' })).toBe('opened');
    expect(await openSpacesPage({ pageId: 'pg-r', currentPageId: 'pg-r' })).toBe('opened');
    expect(events).toEqual([
      { type: OPEN_NATIVE_PAGE_EVENT, detail: { pageId: 'pg-r', workspaceId: 'ws-r', backendConnectionId: 'local' } },
      { type: 'michi:nav-page', detail: { page: 'spaces' } },
    ]);
  });

  it('scrolls to a row of a database on the page on screen', async () => {
    document.body.innerHTML = '<div data-native-database data-database-id="db-t"><div data-row-id="row-7"></div></div>';
    const row = document.querySelector<HTMLElement>('[data-row-id]')!;
    row.scrollIntoView = vi.fn();
    expect(await openSpacesPage({ pageId: 'pg-r', currentPageId: 'pg-r', blockId: 'row-7', databaseId: 'db-t' })).toBe('opened');
    expect(row.scrollIntoView).toHaveBeenCalledOnce();
  });

  it('opens a workspace’s default home as that workspace’s home view, not as a plain page', async () => {
    fetchPage.mockResolvedValue({ id: 'pg-ws-home', workspaceId: 'ws-r' });
    resetSpacesPagesForTests({ home: { id: 'pg-home', title: 'Home' }, workspaces: { 'ws-r': 'pg-ws-home' } });
    expect(await openSpacesPage({ pageId: 'pg-ws-home' })).toBe('opened');
    expect(events).toEqual([{ type: OPEN_WORKSPACE_HOME_EVENT, detail: { workspaceId: 'ws-r', backendConnectionId: 'local' } }]);
  });

  it('reads the home ids before deciding, when nothing in the window has read them yet', async () => {
    fetchPage.mockResolvedValue({ id: 'pg-home', workspaceId: 'sys' });
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith('/workspaces')
      ? { items: [] } : { role: 'spaces-home', page: { id: 'pg-home', title: 'Home', blocks: [] } })))));
    expect(await openSpacesPage({ pageId: 'pg-home' })).toBe('opened');
    expect(events).toEqual([{ type: 'michi:nav-page', detail: { page: 'spaces' } }]);
  });

  it('says a deleted page is gone instead of opening it', async () => {
    resetSpacesPagesForTests({ home: null, workspaces: {} });
    fetchPage.mockRejectedValue(new PageApiError(404, 'not_found', 'Page not found'));
    expect(await openSpacesPage({ pageId: 'pg-gone', workspaceId: 'ws-r' })).toBe('deleted');
    expect(toast).toHaveBeenCalledWith(PAGE_DELETED_MESSAGE);
    expect(events).toEqual([]);
  });
});

describe('loadSpacesHomeIds', () => {
  const answer = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  const homes = (items: Array<{ workspaceId: string; homePageId: string | null }>) => ({ items });
  const home = { role: 'spaces-home', page: { id: 'pg-home', title: 'Home', blocks: [] } };

  it('reads the Spaces Home and each workspace home', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => answer(url.endsWith('/workspaces')
      ? homes([{ workspaceId: 'ws-r', homePageId: 'pg-r-home' }, { workspaceId: 'ws-d', homePageId: null }])
      : home)));
    await loadSpacesHomeIds();
    expect(getSpacesHomeIds()).toEqual({ home: { id: 'pg-home', title: 'Home' }, workspaces: { 'ws-r': 'pg-r-home' } });
  });

  it('reads them again on each call, so a workspace home made meanwhile is known', async () => {
    let items = [{ workspaceId: 'ws-r', homePageId: 'pg-r-home' }];
    vi.stubGlobal('fetch', vi.fn((url: string) => answer(url.endsWith('/workspaces') ? homes(items) : home)));
    await loadSpacesHomeIds();
    items = [...items, { workspaceId: 'ws-b', homePageId: 'pg-b-home' }];
    await loadSpacesHomeIds();
    expect(getSpacesHomeIds().workspaces).toEqual({ 'ws-r': 'pg-r-home', 'ws-b': 'pg-b-home' });
  });

  it('keeps the ids it knew when a later read fails', async () => {
    let failing = false;
    vi.stubGlobal('fetch', vi.fn((url: string) => (failing
      ? answer({ error: 'down' }, 503)
      : answer(url.endsWith('/workspaces') ? homes([{ workspaceId: 'ws-r', homePageId: 'pg-r-home' }]) : home))));
    await loadSpacesHomeIds();
    failing = true;
    await loadSpacesHomeIds();
    expect(getSpacesHomeIds()).toEqual({ home: { id: 'pg-home', title: 'Home' }, workspaces: { 'ws-r': 'pg-r-home' } });
  });

  it('lets the newest read win when an older one answers last', async () => {
    const slow: Array<() => void> = [];
    let items = [{ workspaceId: 'ws-r', homePageId: 'pg-old' }];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (!url.endsWith('/workspaces')) return answer(home);
      const body = homes(items);
      if (slow.length === 0 && items[0].homePageId === 'pg-old') {
        return new Promise<Response>((resolve) => { slow.push(() => resolve(new Response(JSON.stringify(body)))); });
      }
      return answer(body);
    }));
    const older = loadSpacesHomeIds();
    items = [{ workspaceId: 'ws-r', homePageId: 'pg-new' }];
    await loadSpacesHomeIds();
    await vi.waitFor(() => expect(slow).toHaveLength(1));
    slow[0]();
    await older;
    expect(getSpacesHomeIds().workspaces).toEqual({ 'ws-r': 'pg-new' });
  });
});
