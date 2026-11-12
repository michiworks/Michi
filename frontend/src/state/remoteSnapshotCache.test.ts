import { describe, expect, it } from 'vitest';
import { MemoryRemoteCacheStorage, REMOTE_CACHE_PAGE_LIMIT, RemoteSnapshotCache } from './remoteSnapshotCache';

const snapshot = { workspaces: [{ workspace: { id: 'remote:c1:ws', name: 'Remote' } }], lean: true };
const page = { messages: [{ id: 'm1', node_id: 'remote:c1:n1' }], pages: [{ nodeId: 'remote:c1:n1', total: 9, before: { seq: 4, id: 'm1' }, extra: 1 }] };

function cache(options: ConstructorParameters<typeof RemoteSnapshotCache>[1] = {}) {
  let clock = 0;
  const storage = new MemoryRemoteCacheStorage();
  return { storage, cache: new RemoteSnapshotCache(storage, { now: () => ++clock, ...options }) };
}

describe('remote snapshot cache', () => {
  it('keeps the metadata and pages as received, with the thread last open per workspace', async () => {
    const { cache: c } = cache();
    await c.writeSnapshot('u1', 'c1', 'rev-1', snapshot);
    await c.writePage('u1', 'c1', 'rev-1', 'remote:c1:ws', 'remote:c1:t', page);
    await c.noteActiveTree('u1', 'c1', 'rev-1', 'remote:c1:ws', 'remote:c1:t');
    expect(await c.readConnection('u1', 'c1')).toEqual({
      revision: 'rev-1', snapshot, savedAt: 1, activeTrees: { 'remote:c1:ws': 'remote:c1:t' },
    });
    expect(await c.readPage('u1', 'c1', 'rev-1', 'remote:c1:ws', 'remote:c1:t')).toEqual(page);
  });

  it('is scoped by user and connection', async () => {
    const { cache: c } = cache();
    await c.writeSnapshot('u1', 'c1', 'rev-1', snapshot);
    await c.writePage('u1', 'c1', 'rev-1', 'ws', 't', page);
    expect(await c.readConnection('u2', 'c1')).toBeNull();
    expect(await c.readConnection(undefined, 'c1')).toBeNull();
    expect(await c.readConnection('u1', 'c2')).toBeNull();
    expect(await c.readPage('u2', 'c1', 'rev-1', 'ws', 't')).toBeNull();
  });

  it('never answers for another revision, and a write under a new one drops the old copy', async () => {
    const { cache: c } = cache();
    await c.writeSnapshot('u1', 'c1', 'rev-1', snapshot);
    await c.writePage('u1', 'c1', 'rev-1', 'ws', 't', page);
    expect(await c.readPage('u1', 'c1', 'rev-2', 'ws', 't')).toBeNull();
    await c.noteActiveTree('u1', 'c1', 'rev-2', 'ws', 't2');
    expect(await c.readConnection('u1', 'c1')).toEqual({ revision: 'rev-2', snapshot: null, activeTrees: { ws: 't2' } });
    expect(await c.readPage('u1', 'c1', 'rev-1', 'ws', 't')).toBeNull();
  });

  it('clears one connection without touching another or another user', async () => {
    const { cache: c } = cache();
    await c.writeSnapshot('u1', 'c1', 'r', snapshot);
    await c.writeSnapshot('u1', 'c2', 'r', snapshot);
    await c.writeSnapshot('u2', 'c1', 'r', snapshot);
    await c.clearConnection('u1', 'c1');
    expect(await c.readConnection('u1', 'c1')).toBeNull();
    expect((await c.readConnection('u1', 'c2'))?.snapshot).toEqual(snapshot);
    expect((await c.readConnection('u2', 'c1'))?.snapshot).toEqual(snapshot);
    await c.clearAll();
    expect(await c.readConnection('u1', 'c2')).toBeNull();
  });

  it('keeps the most recently read pages, and stays within its byte budget', async () => {
    const { cache: c } = cache();
    for (let i = 0; i <= REMOTE_CACHE_PAGE_LIMIT; i++) await c.writePage('u1', 'c1', 'r', 'ws', `t${i}`, page);
    expect(await c.readPage('u1', 'c1', 'r', 'ws', 't0')).toBeNull();
    expect(await c.readPage('u1', 'c1', 'r', 'ws', `t${REMOTE_CACHE_PAGE_LIMIT}`)).toEqual(page);

    const big = { messages: [{ id: 'x', text: 'y'.repeat(700) }] };
    const small = cache({ maxBytes: 2_000 });
    await small.cache.writeSnapshot('u1', 'c1', 'r', snapshot);
    await small.cache.writePage('u1', 'c1', 'r', 'ws', 'a', big);
    await small.cache.writePage('u1', 'c1', 'r', 'ws', 'b', big);
    await small.cache.writePage('u1', 'c1', 'r', 'ws', 'c', big);
    // Oldest pages go first; the metadata stays while pages can make room.
    expect(await small.cache.readPage('u1', 'c1', 'r', 'ws', 'a')).toBeNull();
    expect(await small.cache.readPage('u1', 'c1', 'r', 'ws', 'c')).toEqual(big);
    expect((await small.cache.readConnection('u1', 'c1'))?.snapshot).toEqual(snapshot);
    // One value over half the budget is not kept at all.
    await small.cache.writePage('u1', 'c1', 'r', 'ws', 'huge', { messages: ['z'.repeat(1_500)] });
    expect(await small.cache.readPage('u1', 'c1', 'r', 'ws', 'huge')).toBeNull();
  });

  it('answers null instead of throwing when its storage fails', async () => {
    const failing = new MemoryRemoteCacheStorage();
    failing.get = async () => { throw new Error('quota'); };
    failing.set = async () => { throw new Error('quota'); };
    const c = new RemoteSnapshotCache(failing);
    await expect(c.writeSnapshot('u1', 'c1', 'r', snapshot)).resolves.toBeUndefined();
    await expect(c.readConnection('u1', 'c1')).resolves.toBeNull();
    await expect(c.readPage('u1', 'c1', 'r', 'ws', 't')).resolves.toBeNull();
  });
});
