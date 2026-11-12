import { useEffect, useState } from 'react';
import { fetchWorkspaceDiff } from '../../../services/api/artifacts';
import { HttpResponseError } from '../../../services/api/httpError';

export type WorkspaceDiffState =
  | { phase: 'empty' }
  | { phase: 'loading' }
  | { phase: 'loaded'; diff: string; truncated: boolean }
  /** `status` is the HTTP status, null when no response came back. */
  | { phase: 'error'; status: number | null; error: unknown };

/** A workspace file's diff; no path is the empty state. */
export function useWorkspaceDiff(workspaceId: string, filePath: string | null): WorkspaceDiffState {
  const [state, setState] = useState<WorkspaceDiffState>(filePath ? { phase: 'loading' } : { phase: 'empty' });
  useEffect(() => {
    if (!filePath) {
      setState({ phase: 'empty' });
      return undefined;
    }
    const controller = new AbortController();
    setState({ phase: 'loading' });
    fetchWorkspaceDiff(workspaceId, filePath, controller.signal).then(
      (diff) => { if (!controller.signal.aborted) setState({ phase: 'loaded', ...diff }); },
      (error: unknown) => {
        // Only this hook's own abort is quiet: backendFetch also throws an
        // AbortError when a remote connection changes mid-read.
        if (!controller.signal.aborted) setState({ phase: 'error', status: error instanceof HttpResponseError ? error.status : null, error });
      },
    );
    return () => controller.abort();
  }, [workspaceId, filePath]);
  return state;
}
