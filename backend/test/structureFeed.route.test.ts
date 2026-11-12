import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { WORKSPACE_STRUCTURE_CHANGED_EVENT } from 'michi-shared';
import { chatHub } from '../src/agents/chatHub';
import { setupMichiRoutes } from '../src/routes/michi';
import type { ChatManager } from '../src/services/chatManager';
import { recordStructureChange, structureEvents } from '../src/services/structureEvents';

type Handler = (req: unknown, res: unknown) => void;

function backgroundSubscribeHandler(): Handler {
  const router = setupMichiRoutes({} as ChatManager) as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> } }>;
  };
  const layer = router.stack.find((candidate) => candidate.route?.path === '/chats/background/subscribe'
    && candidate.route.methods.post);
  assert.ok(layer?.route, 'the background feed route exists');
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/** An SSE response that records frames instead of writing to a socket. */
function fakeSseResponse() {
  const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const writes: string[] = [];
  Object.assign(res, {
    writableEnded: false,
    destroyed: false,
    writableLength: 0,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) { (res.headers as Record<string, string>)[name] = value; },
    flushHeaders() {},
    write(chunk: string) { writes.push(chunk); return true; },
    end() { res.writableEnded = true; },
    status() { return res; },
    json() { return res; },
  });
  const structureFrames = () => writes
    .filter((frame) => frame.startsWith(`event: ${WORKSPACE_STRUCTURE_CHANGED_EVENT}\n`))
    .map((frame) => JSON.parse(frame.split('\ndata: ')[1]));
  return { res, structureFrames };
}

test('the background feed carries structure frames for its owner until the client goes away', async (t) => {
  const previousCloud = process.env.MICHI_CLOUD;
  process.env.MICHI_CLOUD = '1';
  t.mock.method(chatHub, 'subscribeBackground', () => () => {});
  t.after(() => {
    structureEvents.flush();
    if (previousCloud === undefined) delete process.env.MICHI_CLOUD; else process.env.MICHI_CLOUD = previousCloud;
  });
  const handler = backgroundSubscribeHandler();
  structureEvents.flush();

  const { res, structureFrames } = fakeSseResponse();
  handler({ body: { cursors: {}, includeForeground: true }, user: { id: 'alice' }, headers: {} }, res);
  const [opening] = structureFrames();
  assert.deepEqual(opening, { ...structureEvents.cursor('alice'), changes: [] }, 'opens with the cursor');

  recordStructureChange({ entity: 'tree', op: 'created', workspaceId: 'ws-a', treeId: 't-1', ownerUserId: 'alice' });
  recordStructureChange({ entity: 'tree', op: 'created', workspaceId: 'ws-b', treeId: 't-2', ownerUserId: 'bob' });
  structureEvents.flush();
  const frames = structureFrames();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].epoch, opening.epoch);
  assert.equal(frames[1].seq, opening.seq + 1);
  assert.deepEqual(frames[1].changes, [{ entity: 'tree', op: 'created', workspaceId: 'ws-a', treeId: 't-1' }],
    'another owner\'s change never reaches this feed');

  res.emit('close');
  recordStructureChange({ entity: 'tree', op: 'archived', workspaceId: 'ws-a', treeId: 't-1', ownerUserId: 'alice' });
  structureEvents.flush();
  assert.equal(structureFrames().length, 2, 'a closed feed is detached');
});

test('a desktop feed is unscoped and refuses nothing', async (t) => {
  const previousCloud = process.env.MICHI_CLOUD;
  delete process.env.MICHI_CLOUD;
  t.mock.method(chatHub, 'subscribeBackground', () => () => {});
  t.after(() => {
    structureEvents.flush();
    if (previousCloud !== undefined) process.env.MICHI_CLOUD = previousCloud;
  });
  const handler = backgroundSubscribeHandler();
  const { res, structureFrames } = fakeSseResponse();
  handler({ body: { cursors: {} }, headers: {} }, res);
  recordStructureChange({ entity: 'workspace', op: 'renamed', workspaceId: 'ws-1' });
  structureEvents.flush();
  const frames = structureFrames();
  assert.deepEqual(frames.map((frame) => frame.changes.length), [0, 1]);
  res.emit('close');
});
