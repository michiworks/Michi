import { afterEach, expect, it, vi } from 'vitest';
import { fetchTreeMessagePage } from './persistence';
import { backendEntityId } from '../../config/backendIdentity';

afterEach(() => vi.unstubAllGlobals());

it('asks for every node\'s latest messages of a tree with a limit and no node', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages: [], pages: [] })));
  vi.stubGlobal('fetch', fetch);
  await fetchTreeMessagePage(backendEntityId('r', 'ws'), backendEntityId('r', 'tree'), 'r', undefined, { limit: 15 });
  const url = new URL(fetch.mock.calls[0][0], 'http://localhost');
  expect(url.pathname).toMatch(/\/backend-connections\/r\/proxy\/workspaces\/ws\/trees\/tree\/messages$/);
  expect(url.searchParams.get('limit')).toBe('15');
  expect(url.searchParams.has('nodeId')).toBe(false);
  expect(url.searchParams.has('beforeSeq')).toBe(false);
});
