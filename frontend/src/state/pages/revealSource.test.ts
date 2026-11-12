import { beforeEach, describe, expect, it, vi } from 'vitest';
import { revealPageSource } from './revealSource';
import { getSourceNavState, resetSourceNavForTests } from '../sourceNav/sourceNav';

describe('revealPageSource', () => {
  beforeEach(() => { vi.restoreAllMocks(); resetSourceNavForTests(); });
  it('opens the bound source node and scrolls to its exact assistant message, including older IDs', async () => {
    const reveal = vi.fn().mockResolvedValue(true);
    const opened = await revealPageSource(
      { backendConnectionId: 'remote-a', workspaceId: 'workspace' },
      { nodeId: 'node', assistantId: 'answer-old' }, reveal,
    );
    expect(opened).toBe(true);
    expect(reveal).toHaveBeenCalledWith('remote:remote-a:workspace', 'remote:remote-a:node');
    expect(getSourceNavState().jump).toMatchObject({ nodeId: 'remote:remote-a:node', messageId: 'answer-old' });
  });

  it('keeps missing sources unavailable without asking for a scroll', async () => {
    expect(await revealPageSource({ backendConnectionId: 'local', workspaceId: 'w' }, { nodeId: 'deleted', assistantId: 'a' }, vi.fn().mockResolvedValue(false))).toBe(false);
    expect(getSourceNavState().jump).toBeNull();
  });
});
