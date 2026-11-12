import { isPermissionOptionId } from '../contract/permissions';
import { ownerMode, type RuntimeSessionOwner } from '../contract/types';

// Interactions keep their numeric protocol IDs, but must not reuse an ID when
// a node gets a replacement/restored Session: the host answers a request by
// its ID alone. The timestamp seed also keeps a renderer's old replies apart
// from requests after a backend restart.
let lastInteractionRequestId = Date.now() * 1_000;

/** A request ID no session of this process, or of an earlier one, has used. */
export function nextInteractionRequestId(): number {
  lastInteractionRequestId = Math.max(lastInteractionRequestId + 1, Date.now() * 1_000);
  if (!Number.isSafeInteger(lastInteractionRequestId)) throw new Error('Interaction request ID exhausted');
  return lastInteractionRequestId;
}

/** respondToPermission's check: one of the four option ids, and never allow_session for a headless owner. */
export function assertPermissionAnswer(owner: RuntimeSessionOwner, optionId: string): void {
  if (!isPermissionOptionId(optionId) || (optionId === 'allow_session' && ownerMode(owner) === 'headless')) {
    throw new Error('Invalid permission option');
  }
}
