/**
 * Bridges for an older window's id takeover that one flush split over two
 * chunks (domainCommands.ts, takenOver): holder id → when, per sender, noted
 * by the chunk that skipped the takeover's upsert and spent by the delete of
 * that holder in a later chunk. In this process only.
 *
 * Bounded so that one request, one sender and one owner each hold little,
 * and no owner's entries ever push out another's (cloud mode serves many
 * users from one process):
 * - at most `holdersPerName` holders per skipped name (a takeover needs one;
 *   UNIQUE(workspace_id, name) leaves one per exact name, the rest are case
 *   variants), and at most `perSender` per sender, the oldest dropped first,
 *   so one request adds at most `perSender` entries;
 * - at most `sendersPerOwner` senders per owner, the least recently written
 *   dropped first, so one owner churning window ids evicts only their own;
 * - expired entries go on every write to that owner, and from every owner
 *   at most once per `ttlMs` (a sweep), so an owner who stops sending keeps
 *   nothing for long.
 */

export interface TakeoverBridges {
  readonly limits: {
    /** How long a bridge holds (see domainCommands.ts). */
    ttlMs: number;
    holdersPerName: number;
    perSender: number;
    sendersPerOwner: number;
  };
  /** Owner → sender → holder id → when the skip that noted it committed. */
  readonly owners: Map<string, Map<string, Map<string, number>>>;
  /** When expired entries were last dropped from every owner. */
  sweptAt: number;
}

/**
 * Chunks of one flush go one after another, each as soon as the previous one
 * is answered, and an unload's beacons all at once: the next one lands within
 * a second (a few through a remote). Thirty seconds covers that with room and
 * the first retries of a failed chunk (backoff 2, 4, 8 s). A flush's
 * takeovers are the reports a reconnect replayed under names other artifacts
 * took since: a handful, so 64 per sender (a few KB for one request) and 16
 * senders (windows and workspaces mid-flush at once) per owner.
 */
const DEFAULT_LIMITS: TakeoverBridges['limits'] = { ttlMs: 30_000, holdersPerName: 4, perSender: 64, sendersPerOwner: 16 };

export function createTakeoverBridges(limits: Partial<TakeoverBridges['limits']> = {}): TakeoverBridges {
  return { limits: { ...DEFAULT_LIMITS, ...limits }, owners: new Map(), sweptAt: 0 };
}

/** Whether a batch of `sender` (of `owner`) noted `holderId` within the TTL. */
export function takeoverBridged(bridges: TakeoverBridges, owner: string, sender: string, holderId: string, now: number): boolean {
  const at = bridges.owners.get(owner)?.get(sender)?.get(holderId);
  return at !== undefined && now - at <= bridges.limits.ttlMs;
}

/** `senders` without the entries expired at `now`, and without senders left empty. */
function dropExpired(senders: Map<string, Map<string, number>>, now: number, ttlMs: number): void {
  for (const [sender, holders] of senders) {
    for (const [holderId, at] of holders) if (now - at > ttlMs) holders.delete(holderId);
    if (holders.size === 0) senders.delete(sender);
  }
}

/**
 * After a batch of `sender` (of `owner`) committed: the holders it found per
 * skipped name (exact name first), less the bridges it spent.
 */
export function noteTakeoverBridges(
  bridges: TakeoverBridges,
  owner: string,
  sender: string,
  holdersByName: ReadonlyMap<string, readonly string[]>,
  spent: ReadonlySet<string>,
  now: number,
): void {
  const { ttlMs, holdersPerName, perSender, sendersPerOwner } = bridges.limits;
  if (now - bridges.sweptAt >= ttlMs) {
    bridges.sweptAt = now;
    for (const [key, senders] of bridges.owners) {
      dropExpired(senders, now, ttlMs);
      if (senders.size === 0) bridges.owners.delete(key);
    }
  }
  const noted = [...holdersByName.values()].flatMap((holders) => holders.slice(0, holdersPerName));
  const senders = bridges.owners.get(owner);
  if (noted.length === 0 && (spent.size === 0 || !senders?.has(sender))) return;
  const ofOwner = senders ?? new Map<string, Map<string, number>>();
  bridges.owners.set(owner, ofOwner);
  dropExpired(ofOwner, now, ttlMs);
  const holders = ofOwner.get(sender) ?? new Map<string, number>();
  // Most recently written last, so the oldest go first.
  ofOwner.delete(sender);
  for (const holderId of spent) holders.delete(holderId);
  for (const holderId of noted) {
    holders.delete(holderId);
    holders.set(holderId, now);
  }
  for (const holderId of holders.keys()) {
    if (holders.size <= perSender) break;
    holders.delete(holderId);
  }
  if (holders.size > 0) ofOwner.set(sender, holders);
  for (const key of ofOwner.keys()) {
    if (ofOwner.size <= sendersPerOwner) break;
    ofOwner.delete(key);
  }
  if (ofOwner.size === 0) bridges.owners.delete(owner);
}
