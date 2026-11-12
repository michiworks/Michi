import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRunActionApiError, continueAgentRunAsBranch } from './agentRunActions';

afterEach(() => { vi.unstubAllGlobals(); });

const request = {
  version: 1 as const, workspaceId: 'ws', includeTask: true, includeResult: false,
  includeTranscript: true, fallback: 'error' as const,
};

function refuse(status: number, body: unknown): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
  return continueAgentRunAsBranch({ backendConnectionId: 'local', id: 'run-1' }, request, 'op-1')
    .then(() => { throw new Error('expected a refusal'); }, (error: unknown) => error);
}

describe('Agent Run action API', () => {
  it('shows the reason the backend gave, with its code', async () => {
    const error = await refuse(409, { error: 'conflict', message: 'operation op-1 was reused with a different payload' });
    expect(error).toBeInstanceOf(AgentRunActionApiError);
    expect(error).toMatchObject({ code: 'conflict', message: 'operation op-1 was reused with a different payload' });
  });

  it('shows the reason an older backend sent as its error text', async () => {
    const error = await refuse(400, { error: 'includeTask must be boolean' });
    expect(error).toMatchObject({ code: 'request_failed', message: 'includeTask must be boolean' });
  });

  it('falls back to the status when the body has no reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    await expect(continueAgentRunAsBranch({ backendConnectionId: 'local', id: 'run-1' }, request, 'op-1'))
      .rejects.toMatchObject({ code: 'request_failed', message: 'continueAgentRunAsBranch failed: 502' });
  });
});
