import { useSyncExternalStore } from 'react';
import type { CompanionSpacesScreen } from './companionTurnContext';

/**
 * What the area on screen tells the panel for the messages sent from it
 * (DESIGN-v2 §1.3): Pages publishes what its main area shows, Scheduled the
 * workspace New job would preselect. Read when a message is sent; the
 * Chat tab also follows Pages for its starter suggestions.
 */
let spaces: CompanionSpacesScreen | null = null;
let scheduleWorkspaceId: string | null | undefined;
const listeners = new Set<() => void>();

/** Pages is on screen showing this (null: it left). */
export function publishCompanionSpacesScreen(screen: CompanionSpacesScreen | null): void {
  if (screen === spaces) return;
  spaces = screen;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCompanionSpacesScreen(): CompanionSpacesScreen | null {
  return useSyncExternalStore(subscribe, companionSpacesScreen, companionSpacesScreen);
}

export function companionSpacesScreen(): CompanionSpacesScreen | null {
  return spaces;
}

/** Scheduled is on screen and a new job would go in this workspace (null: none to schedule in; undefined: Scheduled left). */
export function publishCompanionScheduleWorkspace(workspaceId: string | null | undefined): void {
  scheduleWorkspaceId = workspaceId;
}

export function companionScheduleWorkspace(): string | null | undefined {
  return scheduleWorkspaceId;
}

/**
 * What the shell shows as one key (F1a-review #9): its page and, in Pages,
 * the view. A block target lets go when it changes (noteCompanionScreen).
 */
export function companionScreenKey(page: string | undefined, screen: CompanionSpacesScreen | null): string {
  const view = screen?.view;
  const viewKey = !view ? ''
    : view.kind === 'page' ? `page:${view.backendConnectionId}:${view.workspaceId}:${view.pageId}`
    : view.kind === 'workspace' ? `workspace:${view.workspaceId}` : 'home';
  return `${page ?? ''}|${viewKey}`;
}

/** @testonly */
export function resetCompanionScreenForTests(): void {
  spaces = null;
  scheduleWorkspaceId = undefined;
}
