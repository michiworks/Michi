import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { CodexRuntime } from 'michi-runtime/internal/adapters/codex/CodexRuntime';
import type { McpSlot } from '../../../src/services/mcpServer';
import { fakeMcpRegistry } from '../../helpers/fakeMcpRegistry';
import { chatOwner } from '../../helpers/owners';
import { codexTestOptions } from '../../helpers/codexTestOptions';
import { assertSchema, validator } from './schema';
import { threadId, tick, wireClient } from './wire';

/**
 * `thread/delete`, the one native-delete call (CodexRuntime.discardNativeSession,
 * DESIGN-v2 §3.2): a native id without an ephemeral home is deleted on the
 * main app-server. The request and its `{}` answer are the official shapes;
 * the `thread/deleted` notification that follows is valid and changes
 * nothing (the request's answer is what the discard waits for).
 */
export async function threadDeleteContract(t: TestContext): Promise<void> {
  const wire = await wireClient(t);
  const runtime = new CodexRuntime({
    ...codexTestOptions(),
    bridge: { spawnBranches: async () => [], saveContext: () => null, updateContext: () => null },
    mcpSlots: fakeMcpRegistry({ create: () => ({ slotId: 'contract-slot' }) as McpSlot, get: () => undefined }, { mcpPort: 0 }),
  }, { client: wire.client });
  t.after(() => runtime.shutdown());
  const result = await runtime.discardNativeSession({
    sessionId: 'n-cmph-contract', owner: chatOwner('n-cmph-contract'), nativeSessionId: threadId, cwd: process.env.MICHI_DATA_DIR!,
  });
  const requests = wire.outgoing.filter((message) => message.method === 'thread/delete');
  assert.equal(requests.length, 1);
  assertSchema('ClientRequest', requests[0]);
  assert.deepEqual(requests[0].params, { threadId });
  assert.equal(validator('ThreadDeleteResponse')({}), true);
  assert.equal(result, 'discarded');
  wire.send({ method: 'thread/deleted', params: { threadId } }, 'ServerNotification');
  await tick();
  assert.equal(wire.outgoing.filter((message) => message.method === 'thread/delete').length, 1, 'the notification starts nothing');
}
