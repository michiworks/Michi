import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryRecord, MemoryScope } from 'michi-shared';
import type { PageId } from '../../../../state/commands';
import type { Project } from '../../../../state/chatTypes';
import { useChatActions, useChatProjects } from '../../../../state/chatStore';
import { isSystemWorkspace } from '../../../../state/assistant/systemWorkspace';
import { onMemoryChanged } from '../../../../state/memory/memoryNotifications';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import {
  fetchMemoryProfile,
  listMemories,
  rebuildMemoryProfile,
  type MemoryProfileView,
} from '../../../../services/api/memories';
import { sameScope } from './memoryLibrary';

/**
 * What Settings › Memory reads: every active memory on this machine (pages of
 * LIBRARY_PAGE, at most LIBRARY_MAX), About the user, and the workspace names
 * and scopes its pages offer. Both are read again when a memory changes
 * anywhere (an agent, automatic memory, another window).
 */

const LIBRARY_PAGE = 200;
export const LIBRARY_MAX = 2_000;
const RELOAD_DEBOUNCE_MS = 250;
/** While a requested rebuild waits for automatic memory, the profile is read again this often, for at most this long. */
const REBUILD_POLL_MS = 4_000;
const REBUILD_POLL_LIMIT_MS = 5 * 60_000;

export function errorText(error: unknown, fallback = 'unknown error'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Runs `listener` once a burst of memory changes settles. */
function useMemoryChanges(listener: () => void): void {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = onMemoryChanged(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; ref.current(); }, RELOAD_DEBOUNCE_MS);
    });
    return () => { stop(); if (timer !== null) clearTimeout(timer); };
  }, []);
}

export interface MemoryLibrary {
  status: 'loading' | 'ready' | 'error';
  records: MemoryRecord[];
  /** More than LIBRARY_MAX are stored: the newest are listed. */
  truncated: boolean;
  error: string | null;
  reload: () => Promise<void>;
  /** A write's answer, kept until the next read. */
  replace: (record: MemoryRecord) => void;
  remove: (id: string) => void;
  add: (record: MemoryRecord) => void;
}

/** `reloadKey` changes when every memory was deleted. */
export function useMemoryLibrary(reloadKey: number): MemoryLibrary {
  const [state, setState] = useState<{ status: MemoryLibrary['status']; records: MemoryRecord[]; truncated: boolean; error: string | null }>(
    { status: 'loading', records: [], truncated: false, error: null });
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const records: MemoryRecord[] = [];
      let cursor: string | null = null;
      do {
        const page = await listMemories({ status: ['active'], limit: LIBRARY_PAGE, cursor });
        if (mine !== generation.current) return;
        records.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && records.length < LIBRARY_MAX);
      const seen = new Set<string>();
      setState({ status: 'ready', records: records.filter((record) => !seen.has(record.id) && !!seen.add(record.id)), truncated: !!cursor, error: null });
    } catch (error) {
      if (mine !== generation.current) return;
      setState((current) => ({ ...current, status: current.status === 'ready' ? 'ready' : 'error', error: errorText(error) }));
    }
  }, []);

  useEffect(() => { void reload(); }, [reload, reloadKey]);
  useMemoryChanges(() => { void reload(); });

  const edit = useCallback((change: (records: MemoryRecord[]) => MemoryRecord[]) => {
    generation.current += 1;
    setState((current) => ({ ...current, records: change(current.records) }));
  }, []);
  return useMemo(() => ({
    ...state,
    reload,
    replace: (record) => edit((records) => records.map((item) => item.id === record.id ? record : item)),
    remove: (id) => edit((records) => records.filter((item) => item.id !== id)),
    add: (record) => edit((records) => [record, ...records.filter((item) => item.id !== record.id)]),
  }), [state, reload, edit]);
}

export interface MemoryProfile {
  status: 'loading' | 'ready' | 'unavailable' | 'error';
  view: MemoryProfileView | null;
  /** Rebuild was asked for here and has not been answered yet, or failed (`rebuildError`). */
  requesting: boolean;
  rebuildError: string | null;
  rebuild: () => Promise<void>;
}

/** About the user (GET /api/memory-profile); null view on a backend without one. */
export function useMemoryProfile(reloadKey: number): MemoryProfile {
  const [state, setState] = useState<{ status: MemoryProfile['status']; view: MemoryProfileView | null }>({ status: 'loading', view: null });
  const [requesting, setRequesting] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const view = await fetchMemoryProfile();
      if (mine === generation.current) setState(view ? { status: 'ready', view } : { status: 'unavailable', view: null });
    } catch {
      if (mine === generation.current) setState((current) => ({ status: current.view ? 'ready' : 'error', view: current.view }));
    }
  }, []);
  useEffect(() => { void load(); }, [load, reloadKey]);
  useMemoryChanges(() => { void load(); });

  const requested = state.view?.rebuildRequested === true;
  useEffect(() => {
    if (!requested) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > REBUILD_POLL_LIMIT_MS) clearInterval(timer);
      else void load();
    }, REBUILD_POLL_MS);
    return () => clearInterval(timer);
  }, [requested, load]);

  const rebuild = useCallback(async () => {
    setRequesting(true);
    setRebuildError(null);
    try {
      const view = await rebuildMemoryProfile();
      generation.current += 1;
      setState({ status: 'ready', view });
    } catch (error) {
      setRebuildError(`Couldn’t ask for a rebuild: ${errorText(error)}`);
    } finally {
      setRequesting(false);
    }
  }, []);

  return { ...state, requesting, rebuildError, rebuild };
}

/** Workspace names, scopes the user can pick, and opening a memory's source conversation. */
export interface MemoryContext {
  /** The open workspace, when it is on this machine (its memories are here). */
  workspace: Project | null;
  scopeLabel: (scope: MemoryScope) => string;
  scopeChoices: (current?: MemoryScope) => MemoryScope[];
  /** The source conversation when this machine has it loaded. */
  sourceNode: (record: MemoryRecord) => string | null;
  openSource: (nodeId: string) => void;
}

export function useMemoryContext(onNav?: (page: PageId) => void): MemoryContext {
  const { projects, activeProject } = useChatProjects();
  const { revealNode } = useChatActions();
  const workspace = activeProject && !activeProject.deletedAt && !activeProject.archivedAt && !isSystemWorkspace(activeProject)
    && backendConnectionIdForWorkspace(activeProject.id) === LOCAL_BACKEND_CONNECTION_ID ? activeProject : null;
  return useMemo(() => {
    const workspaceName = (id: string) => projects.find((project) => project.id === id)?.name || 'Another workspace';
    return {
      workspace,
      scopeLabel: (scope) => scope.kind === 'user' ? 'Everywhere' : workspaceName(scope.workspaceId),
      scopeChoices: (current) => {
        const choices: MemoryScope[] = [{ kind: 'user' }];
        if (workspace) choices.push({ kind: 'workspace', workspaceId: workspace.id });
        if (current && !choices.some((choice) => sameScope(choice, current))) choices.push(current);
        return choices;
      },
      sourceNode: (record) => {
        const nodeId = record.source?.nodeId;
        if (!nodeId) return null;
        return projects.some((project) => !project.deletedAt && project.chatIds.includes(nodeId)) ? nodeId : null;
      },
      // An explicit request: opens the conversation wherever it lives, then leaves Settings.
      openSource: (nodeId) => {
        revealNode(nodeId);
        onNav?.('dashboard');
      },
    };
  }, [projects, workspace, revealNode, onNav]);
}
