import { createContext, useContext } from 'react';
import { backendEntityId, LOCAL_BACKEND_CONNECTION_ID } from '../../../config/backendIdentity';

/**
 * The backend connection the Markdown under it came from. An agent on a
 * remote machine writes that machine's own ids into its michi:// links,
 * and this window holds them under the connection's ids. Unset, the
 * content is this machine's.
 */
export const MichiLinkConnectionContext = createContext<string>(LOCAL_BACKEND_CONNECTION_ID);

/** This window's id for what a link names where it was written; null when it can name nothing there. */
export function useMichiLinkEntityId(id: string): string | null {
  const connectionId = useContext(MichiLinkConnectionContext);
  try {
    return backendEntityId(connectionId, id);
  } catch {
    // Another connection's id, as seen from that remote machine.
    return null;
  }
}
