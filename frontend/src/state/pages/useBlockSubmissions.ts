import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blockSubmissionHostKey, blockSubmissionSignature, type BlockSubmission, type BlockSubmissionHost } from 'michi-shared';
import { createBlockSubmission, listBlockSubmissions } from '../../services/api/blockSubmissions';

export interface BlockSubmissions {
  /** The latest submission of each block id, whatever its signature. */
  byBlock: Map<string, BlockSubmission>;
  /** The host's stored submissions have loaded. */
  ready: boolean;
  /** They could not be loaded (a backend without this API, a host it does not find): blocks then behave as without submissions. */
  unavailable: boolean;
  /** The submission of a block for one signature of its content. */
  find(blockId: string, signature: string): BlockSubmission | undefined;
  /**
   * Stores a submission. Resolves with it when it was stored now; with null
   * when it was not: the block already had one for this signature (which
   * `byBlock` and `find` then hold), or the write failed.
   */
  submit(blockId: string, signature: string, value: unknown, text: string): Promise<BlockSubmission | null>;
}

type Loaded = { scope: string | null; items: ReadonlyMap<string, BlockSubmission>; status: 'loading' | 'ready' | 'failed' };

const key = (blockId: string, signature: string) => `${blockId}\u0000${signature}`;
const EMPTY: ReadonlyMap<string, BlockSubmission> = new Map();

function withSubmissions(items: ReadonlyMap<string, BlockSubmission>, added: readonly BlockSubmission[]): ReadonlyMap<string, BlockSubmission> {
  const next = new Map(items);
  for (const submission of added) next.set(key(submission.blockId, submission.signature), submission);
  return next;
}

/**
 * What was submitted through the interactive blocks of one host (a page or
 * a chat message) on the backend `connectionId` names, and the way to store
 * a new submission. `host` null: no host, nothing loads or is stored.
 */
export function useBlockSubmissions(connectionId: string, workspaceId: string, host: BlockSubmissionHost | null): BlockSubmissions {
  const hostKey = host ? blockSubmissionHostKey(host) : null;
  const scope = hostKey ? JSON.stringify([connectionId, workspaceId, hostKey]) : null;
  const hostRef = useRef(host);
  hostRef.current = host;
  const [loaded, setLoaded] = useState<Loaded>({ scope: null, items: EMPTY, status: 'loading' });

  useEffect(() => {
    const target = hostRef.current;
    if (!scope || !target) return;
    const controller = new AbortController();
    setLoaded({ scope, items: EMPTY, status: 'loading' });
    listBlockSubmissions(connectionId, workspaceId, target, controller.signal).then(
      // A submission stored while the list was on its way stays: it is the server's answer too.
      (items) => setLoaded((current) => current.scope === scope ? { scope, items: withSubmissions(EMPTY, [...items, ...current.items.values()]), status: 'ready' } : current),
      () => { if (!controller.signal.aborted) setLoaded((current) => current.scope === scope ? { ...current, status: 'failed' } : current); },
    );
    return () => controller.abort();
  }, [connectionId, workspaceId, scope]);

  const current = loaded.scope === scope ? loaded : null;
  const items = current?.items ?? EMPTY;

  const submit = useCallback(async (blockId: string, signature: string, value: unknown, text: string) => {
    const target = hostRef.current;
    if (!scope || !target) return null;
    try {
      const result = await createBlockSubmission(connectionId, workspaceId, { host: target, blockId, signature, value, text });
      setLoaded((state) => state.scope === scope ? { ...state, items: withSubmissions(state.items, [result.submission]) } : state);
      return result.status === 'created' ? result.submission : null;
    } catch { return null; }
  }, [connectionId, workspaceId, scope]);

  return useMemo(() => {
    const byBlock = new Map<string, BlockSubmission>();
    for (const submission of items.values()) {
      const latest = byBlock.get(submission.blockId);
      if (!latest || latest.submittedAt <= submission.submittedAt) byBlock.set(submission.blockId, submission);
    }
    return {
      byBlock,
      ready: current?.status === 'ready',
      unavailable: current?.status === 'failed',
      find: (blockId: string, signature: string) => items.get(key(blockId, signature)),
      submit,
    };
  }, [current?.status, items, submit]);
}

type SubmittableBlock = { id?: unknown; type?: unknown; [key: string]: unknown };

/**
 * The block context's submission hooks (MichiBlockCtx.submissionFor and
 * recordSubmission) over one host's submissions. `canRecord` false (a
 * read-only page, an archived conversation) shows what was submitted and
 * stores nothing; so does a host whose submissions could not be loaded,
 * where blocks send as they do without submissions. A block without an id
 * has nothing to keep its submission under: it sends unrecorded.
 */
export function blockSubmissionCtx(submissions: BlockSubmissions, canRecord: boolean): {
  submissionFor: (block: SubmittableBlock) => BlockSubmission | undefined;
  recordSubmission?: (block: SubmittableBlock, signature: string, value: unknown, text: string) => Promise<boolean>;
} {
  const id = (block: SubmittableBlock) => typeof block.id === 'string' && block.id ? block.id : null;
  return {
    submissionFor: (block) => { const blockId = id(block); return blockId ? submissions.find(blockId, blockSubmissionSignature(block)) : undefined; },
    ...(canRecord && !submissions.unavailable ? {
      recordSubmission: async (block: SubmittableBlock, signature: string, value: unknown, text: string) => {
        const blockId = id(block);
        return blockId ? (await submissions.submit(blockId, signature, value, text)) !== null : true;
      },
    } : {}),
  };
}
