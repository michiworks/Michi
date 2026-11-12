import { beforeEach, expect, it, vi } from 'vitest';
import { nextQueuedBatch, executeComposerCommand } from './chatCommands';
import { executeChatCommand } from '../services/api/sessions';
import { compactChat } from '../services/api';
import type { PendingQueuedMessage } from './chatTypes';
import { buildSlashEntries } from './slashEntries';
vi.mock('../services/api/sessions', () => ({ executeChatCommand: vi.fn() }));
vi.mock('../services/api', () => ({ compactChat: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
const queued = (value: string, extra: Partial<PendingQueuedMessage> = {}): PendingQueuedMessage =>
  ({ id: value, value, mentions: [], attachments: [], queuedAt: 0, ...extra });

const entries = buildSlashEntries({
  runtimeId: 'kiro',
  catalog: { commands: [{ name: 'context' }, { name: 'tools' }], skills: [
    { id: 'library:review', name: 'review', origin: 'library', description: 'Review', userInvocable: true, modelInvocable: true, enabled: true },
    { id: 'library:context', name: 'context', origin: 'library', description: 'Gather', userInvocable: true, modelInvocable: true, enabled: true },
  ] },
});

it('drains commands and skills one at a time, merging the ordinary messages between them', () => {
  const queue = [queued('one'), queued('two'), queued('/tools'), queued('/review the diff'), queued('three'), queued('/unknown'), queued('four')];
  expect(nextQueuedBatch(queue, entries)).toEqual(queue.slice(0, 2));
  expect(nextQueuedBatch(queue.slice(2), entries)).toEqual(queue.slice(2, 3));
  expect(nextQueuedBatch(queue.slice(3), entries)).toEqual(queue.slice(3, 4));
  // A /word nothing runs is a message like any other.
  expect(nextQueuedBatch(queue.slice(4), entries)).toEqual(queue.slice(4));
  // The skill row picked for `/context` runs alone too.
  const picked = entries.find((entry) => entry.skill?.id === 'library:context')!;
  expect(nextQueuedBatch([queued('/context why', { slash: { entry: picked, runtimeId: 'kiro' } }), queued('more')], entries)).toHaveLength(1);
});

it('runs compact through Michi and other commands through the runtime, with visible results and failures', async () => {
  vi.mocked(compactChat).mockResolvedValue({ started: true, detail: 'Completed' });
  expect(await executeComposerCommand('node', { name: 'compact', value: 'keep decisions' })).toEqual({ success: true, message: 'Completed' });
  expect(compactChat).toHaveBeenCalledWith('node', 'keep decisions');
  vi.mocked(executeChatCommand).mockResolvedValue({ success: true, data: { tokens: 123 },
    sessionState: { runtimeId: 'claude', nativeEngine: 'agent-sdk', modelId: 'claude-sonnet-4-6' } });
  const result = await executeComposerCommand('node', { name: 'model', value: 'claude-sonnet-4-6' });
  expect(result).toMatchObject({ success: true, sessionState: { runtimeId: 'claude', nativeEngine: 'agent-sdk' } });
  expect(result.message).toContain('123');
  expect(executeChatCommand).toHaveBeenLastCalledWith('node', 'model', { value: 'claude-sonnet-4-6' });
  vi.mocked(executeChatCommand).mockResolvedValue({ success: false, message: 'Unsupported by server' });
  expect((await executeComposerCommand('node', { name: 'unknown' })).message).toBe('Unsupported by server');
});
