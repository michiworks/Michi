import { useEffect, useMemo, type ReactNode } from 'react';
import { useChatProjects } from '../../../../state/chatStore';
import { loadSpacesHomeIds } from '../../../../state/metaChat/spacesPages';
import { SPACES_SUGGESTIONS } from '../../../../state/metaChat/suggestions';
import type { MetaChatView } from '../../../../state/metaChat/turnContext';
import { refreshMetaAgent } from '../../../../state/metaAgent/useMetaAgent';
import { useSpacesFirstRun } from '../../../../state/metaAgent/spacesFirstRun';
import { spacesSupportsConnection } from '../../../../state/metaAgent/remoteSpaces';
import { backendConnectionIdForWorkspace, LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import { firstRunOpensWindow, noteFirstRunOpenedWindow } from '../../../../state/metaChat/firstRunWindow';
import { openCompanionPanel } from '../../../../state/companion/companionPanel';
import { publishCompanionSpacesScreen } from '../../../../state/companion/companionScreen';
import { subscribePageChanges } from '../../../../state/pages/pageEvents';
import { namesRemoteEntity } from '../../../../config/backendIdentity';

/** What the Spaces main area shows. */
export type SpacesChatView = MetaChatView;

export { SPACES_SUGGESTIONS };

/**
 * The Pages area's bridge to the panel (DESIGN-v2 §1.4: the Spaces window is
 * retired). While Pages is on screen it tells the panel what its main area
 * shows (each message's Spaces fields, §1.3; the panel host drops a block
 * target when that changes), loads the home page ids those name, and opens
 * the panel once when the Pages upkeep's first run starts (§1.3 "自动打开").
 * Renders its children as they are.
 */
export function SpacesMetaChat({ active, view, children }: {
  active: boolean;
  view: SpacesChatView;
  children: ReactNode;
}) {
  const { projects } = useChatProjects();
  const workspaces = useMemo(
    () => projects.filter((p) => !p.system && !p.deletedAt && !namesRemoteEntity(p.id)).map((p) => ({ id: p.id, name: p.name })),
    [projects],
  );
  // Spaces doesn't support remote connections yet: the agent is told their names so it can say so when asked.
  const remoteWorkspaces = useMemo(
    () => projects.filter((p) => !p.system && !p.deletedAt && !p.archivedAt && !spacesSupportsConnection(backendConnectionIdForWorkspace(p.id)))
      .map((p) => ({ id: p.id, name: p.name })),
    [projects],
  );

  useEffect(() => {
    if (!active) return undefined;
    publishCompanionSpacesScreen({ view, workspaces, remoteWorkspaces });
    return () => publishCompanionSpacesScreen(null);
  }, [active, view, workspaces, remoteWorkspaces]);

  useEffect(() => {
    if (active) void refreshMetaAgent();
  }, [active]);

  // The home page ids name the Spaces Home and workspace homes in each message's context.
  // Read again on every return: a workspace made meanwhile has a home this view hasn't seen.
  useEffect(() => {
    if (!active) return undefined;
    const reload = () => { void loadSpacesHomeIds(); };
    reload();
    return subscribePageChanges({ backendConnectionId: LOCAL_BACKEND_CONNECTION_ID }, reload);
  }, [active]);

  // A block target belongs to the screen it was set on: the panel host lets it go when the shell's
  // page or Pages' view changes, leaving Pages included (companionScreenKey, F1a-review #9).

  // A first run opens the panel once, when it starts while Pages is on screen.
  const firstRun = useSpacesFirstRun(LOCAL_BACKEND_CONNECTION_ID);
  useEffect(() => {
    if (!active || !firstRunOpensWindow(LOCAL_BACKEND_CONNECTION_ID, firstRun.data)) return;
    noteFirstRunOpenedWindow(LOCAL_BACKEND_CONNECTION_ID, firstRun.data!.requestedAt!);
    openCompanionPanel({ tab: 'chat', focusComposer: false });
  }, [active, firstRun.data]);

  return <>{children}</>;
}
