import { createContext, useContext } from 'react';

/**
 * The one way to open the Background work drawer. TerminalShell owns the
 * drawer and listens for this window event; the pane-title badge, the
 * top-bar background work button and the in-chat subagent / workflow cards
 * dispatch it on a user click. Nothing else may dispatch it: background
 * progress never opens the drawer.
 */
export const OPEN_BACKGROUND_WORK_EVENT = 'michi:open-background-work';

export type BackgroundWorkFocus =
  | { kind: 'subagent'; sessionId: string }
  /** threadKey/step: a multi-model run's row (plan key, step 0..2) to expand. */
  | { kind: 'workflow'; runKey: string; threadKey?: string; step?: number };

/** Multi-model plan keys are "t1".."t5" and "a1".. (shared/src/multiModel.ts). */
const THREAD_KEY_MAX_CHARS = 8;
const STEP_MAX = 2;

export interface OpenBackgroundWorkDetail {
  /** Conversation (chat node) the drawer is scoped to. */
  nodeId: string;
  /** Item to expand and scroll into view. */
  focus?: BackgroundWorkFocus;
}

export function openBackgroundWork(detail: OpenBackgroundWorkDetail): void {
  window.dispatchEvent(new CustomEvent<OpenBackgroundWorkDetail>(OPEN_BACKGROUND_WORK_EVENT, { detail }));
}

/** A multi-model row (plan key, step) to expand inside a workflow run. */
export type WorkflowRunFocus = Omit<Extract<BackgroundWorkFocus, { kind: 'workflow' }>, 'kind' | 'runKey'>;

/**
 * Open the drawer on a workflow run, in the conversation that owns it
 * (the run's `nodeId`; the drawer lists only that conversation's runs).
 * Workflow and multi-model cards both open their run this way.
 */
export function openWorkflowRunDrawer(ownerNodeId: string, runKey: string, focus?: WorkflowRunFocus): void {
  openBackgroundWork({ nodeId: ownerNodeId, focus: { kind: 'workflow', runKey, ...focus } });
}

function readFocus(value: unknown): BackgroundWorkFocus | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const focus = value as Record<string, unknown>;
  if (focus.kind === 'subagent' && typeof focus.sessionId === 'string' && focus.sessionId) {
    return { kind: 'subagent', sessionId: focus.sessionId };
  }
  if (focus.kind === 'workflow' && typeof focus.runKey === 'string' && focus.runKey) {
    const { threadKey, step } = focus;
    return {
      kind: 'workflow',
      runKey: focus.runKey,
      ...(typeof threadKey === 'string' && threadKey && threadKey.length <= THREAD_KEY_MAX_CHARS ? { threadKey } : {}),
      ...(typeof step === 'number' && Number.isInteger(step) && step >= 0 && step <= STEP_MAX ? { step } : {}),
    };
  }
  return undefined;
}

/** Validated event detail, or null for a malformed event. */
export function readOpenBackgroundWorkDetail(event: Event): OpenBackgroundWorkDetail | null {
  const detail = (event as CustomEvent<unknown>).detail;
  if (!detail || typeof detail !== 'object') return null;
  const { nodeId, focus } = detail as Record<string, unknown>;
  if (typeof nodeId !== 'string' || !nodeId) return null;
  const parsed = readFocus(focus);
  return parsed ? { nodeId, focus: parsed } : { nodeId };
}

/** Subscribe to open requests; returns the unsubscribe function. */
export function onOpenBackgroundWork(handler: (detail: OpenBackgroundWorkDetail) => void): () => void {
  const listener = (event: Event) => {
    const detail = readOpenBackgroundWorkDetail(event);
    if (detail) handler(detail);
  };
  window.addEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
  return () => window.removeEventListener(OPEN_BACKGROUND_WORK_EVENT, listener);
}

/**
 * The chat node whose transcript is rendering, for in-chat cards deep in the
 * message tree. Provided by PaneMessageList; null elsewhere (specimens,
 * provider-free tests), where cards render without the drawer link.
 */
export const BackgroundWorkNodeContext = createContext<string | null>(null);

export function useBackgroundWorkNodeId(): string | null {
  return useContext(BackgroundWorkNodeContext);
}
