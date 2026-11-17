import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockSubmissionSignature, type BlockSubmissionHost } from 'michi-shared';
import { blockSubmissionCtx, useBlockSubmissions } from './useBlockSubmissions';

afterEach(() => { vi.unstubAllGlobals(); });

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const poll = { id: 'blk-1', type: 'poll', question: 'When?', options: ['Mon', 'Tue'] };
const signature = blockSubmissionSignature(poll);
const stored = { blockId: 'blk-1', signature, value: [1], text: 'Tue', submittedAt: 5 };
// Stable across renders, as a host built with useMemo is.
const PAGE: BlockSubmissionHost = { kind: 'page', pageId: 'remote:host:pg-1' };

describe('useBlockSubmissions', () => {
  it('loads a remote page host by its server ids and finds a block by id and signature', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { submissions: [stored] }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBlockSubmissions('host', 'remote:host:ws-1', PAGE));
    await waitFor(() => expect(result.current.ready).toBe(true));
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/backend-connections/host/proxy/workspaces/ws-1/block-submissions?host=page%3Apg-1');
    expect(result.current.byBlock.get('blk-1')).toEqual(stored);
    const ctx = blockSubmissionCtx(result.current, true);
    expect(ctx.submissionFor(poll)).toEqual(stored);
    // A rewritten block (other options) has no submission yet.
    expect(ctx.submissionFor({ ...poll, options: ['Wed'] })).toBeUndefined();
  });

  it('records a submission, and on 409 holds the stored one and reports nothing recorded', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(200, { submissions: [] }))
      .mockResolvedValueOnce(json(201, { submission: stored }))
      .mockResolvedValueOnce(json(409, { code: 'already_submitted', submission: { ...stored, signature: 'other', value: [0] } }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBlockSubmissions('host', 'remote:host:ws-1', PAGE));
    await waitFor(() => expect(result.current.ready).toBe(true));
    let recorded: boolean | undefined;
    await act(async () => { recorded = await blockSubmissionCtx(result.current, true).recordSubmission!(poll, signature, [1], 'Tue'); });
    expect(recorded).toBe(true);
    const [, init] = fetchMock.mock.calls[1];
    // The value is the person's own: never id-mapped, even with a key that looks like an entity field.
    expect(JSON.parse(init.body as string)).toEqual({ host: { kind: 'page', pageId: 'pg-1' }, blockId: 'blk-1', signature, value: [1], text: 'Tue' });
    expect(result.current.find('blk-1', signature)).toEqual(stored);

    let again: unknown;
    await act(async () => { again = await result.current.submit('blk-1', 'other', { workspaceId: 'remote:host:x' }, 'Mon'); });
    expect(again).toBeNull();
    expect(result.current.find('blk-1', 'other')?.value).toEqual([0]);
  });

  it('leaves recording out where the list could not load or the host may not record', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Cannot GET', { status: 404 })));
    const { result } = renderHook(() => useBlockSubmissions('local', 'ws-1', { kind: 'page', pageId: 'pg-1' }));
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(blockSubmissionCtx(result.current, true).recordSubmission).toBeUndefined();
    expect(blockSubmissionCtx(result.current, false).recordSubmission).toBeUndefined();
  });

  it('a failed write records nothing, and a block without an id sends unrecorded', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, { submissions: [] })).mockResolvedValueOnce(json(500, { error: { code: 'internal_error', message: 'x' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBlockSubmissions('local', 'ws-1', { kind: 'chat', nodeId: 'n1', messageId: 'm1' }));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(String(fetchMock.mock.calls[0][0])).toContain('host=chat%3An1%3Am1');
    const ctx = blockSubmissionCtx(result.current, true);
    let recorded: boolean | undefined;
    await act(async () => { recorded = await ctx.recordSubmission!(poll, signature, [0], 'Mon'); });
    expect(recorded).toBe(false);
    expect(result.current.byBlock.size).toBe(0);
    await act(async () => { recorded = await ctx.recordSubmission!({ type: 'poll', options: ['a'] }, 's', [0], 'a'); });
    expect(recorded).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('loads nothing without a host', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useBlockSubmissions('local', 'ws-1', null));
    expect(result.current.ready).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
