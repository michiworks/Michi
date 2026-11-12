import { LOCAL_BACKEND_CONNECTION_ID } from '../config/backendConnections';
import { WINDOW_ID } from '../config/windowIdentity';
import { getElectron } from '../lib/electronBridge';
import type { TerminalPaneItem } from './paneItems';

/**
 * Where a terminal pane's shell runs. Electron windows keep local workspaces
 * on their own PTY (electron/main.ts). Everything else (a phone, a browser,
 * a remote workspace) uses a terminal the workspace's backend runs.
 */
export type TerminalTarget =
  | { transport: 'native' }
  | { transport: 'backend'; connectionId: string };

export function hasNativeTerminal(): boolean {
  const electron = getElectron();
  return Boolean(electron?.terminalCreate && electron.terminalWrite && electron.terminalResize);
}

/** For a new terminal in this workspace. */
export function terminalTargetForWorkspace(workspace: { backendConnectionId?: string } | undefined): TerminalTarget {
  if (workspace?.backendConnectionId) return { transport: 'backend', connectionId: workspace.backendConnectionId };
  return hasNativeTerminal() ? { transport: 'native' } : { transport: 'backend', connectionId: LOCAL_BACKEND_CONNECTION_ID };
}

/** For an existing pane. Panes saved before backend terminals use the native PTY where there is one. */
export function terminalTargetForPane(item: TerminalPaneItem): TerminalTarget {
  if (item.transport !== 'backend' && hasNativeTerminal()) return { transport: 'native' };
  return { transport: 'backend', connectionId: item.backendConnectionId ?? LOCAL_BACKEND_CONNECTION_ID };
}

/** The pane item fields for a target. */
export function terminalPaneFields(target: TerminalTarget): Pick<TerminalPaneItem, 'transport' | 'backendConnectionId'> {
  return target.transport === 'backend' ? { transport: 'backend', backendConnectionId: target.connectionId } : {};
}

/** This window, as the terminal backend counts its viewers. Stable across reloads. */
export const TERMINAL_CLIENT_ID = WINDOW_ID.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'window';
