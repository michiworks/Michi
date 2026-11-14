import { LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import { openCompanionPanel } from '../../../../state/companion/companionPanel';
import { companionIsOff, useCompanion } from '../../../../state/companion/companionStore';

/**
 * A page's `home-section` block (the Pages Home's Waiting, Stalled or Done
 * before D13): Today is the one list of what needs you (Q12), so the block
 * is one line that counts it and opens it. Today is this computer's agent's,
 * so a remote page's block shows nothing, and neither does one while the
 * agent is off (Q29): Today is in its panel.
 */
export function NativeHomeSection({ connectionId }: { connectionId: string }) {
  const companion = useCompanion();
  const { snapshot } = companion;
  if (connectionId !== LOCAL_BACKEND_CONNECTION_ID || !snapshot || companionIsOff(companion)) return null;
  const count = snapshot.counts.needsYou;
  return (
    <p className="spaces-home-needs-you" role="status">
      {count === 0 ? 'Nothing needs you right now' : `${count} ${count === 1 ? 'thing needs' : 'things need'} you`}
      {' · '}
      <button type="button" className="spaces-home-link" onClick={() => openCompanionPanel({ tab: 'today' })}>Open Today</button>
    </p>
  );
}
