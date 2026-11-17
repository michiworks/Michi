import { LOCAL_BACKEND_CONNECTION_ID } from '../../../../config/backendConnections';
import { openCompanionPanel } from '../../../../state/companion/companionPanel';
import { companionIsOff, useCompanion } from '../../../../state/companion/companionStore';
import { companionWaitingItems } from '../../../../state/companion/companionToday';
import { useMinuteClock } from '../../content/home/useMinuteClock';

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
  // A raise holds for the day it was given on, so a block left open past midnight counts afresh.
  const clock = useMinuteClock(true);
  if (connectionId !== LOCAL_BACKEND_CONNECTION_ID || !snapshot || companionIsOff(companion)) return null;
  // Counted from the items, as Today's header counts them (companionToday.ts).
  const count = companionWaitingItems(snapshot.items, clock).length;
  return (
    <p className="spaces-home-needs-you" role="status">
      {count === 0 ? 'Nothing needs you right now' : `${count} ${count === 1 ? 'thing needs' : 'things need'} you`}
      {' · '}
      <button type="button" className="spaces-home-link" onClick={() => openCompanionPanel({ tab: 'today' })}>Open Today</button>
    </p>
  );
}
