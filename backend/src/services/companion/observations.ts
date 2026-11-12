/**
 * Fingerprints and diffs of what the sources observe. A fingerprint is a
 * hash of a stable serialization (object keys sorted), so the same state
 * always hashes the same however it was assembled. diffObservations compares
 * a poll with the stored snapshots and yields the snapshots to store next,
 * keeping `fingerprintSince` while an object stays the same ("unchanged for
 * two working days").
 */

import { createHash } from 'node:crypto';
import type { CompanionSnapshotRecord, Observation } from './types';

/**
 * JSON with every object's keys sorted. Like JSON.stringify, undefined,
 * functions and symbols are left out of objects and become null in arrays,
 * and non-finite numbers become null. Throws on cycles and bigints.
 */
export function stableStringify(value: unknown): string {
  const seen = new Set<object>();
  const write = (current: unknown, inArray: boolean): string | undefined => {
    if (current === null) return 'null';
    if (current instanceof Date) return JSON.stringify(current.toJSON());
    switch (typeof current) {
      case 'string':
        return JSON.stringify(current);
      case 'number':
        return Number.isFinite(current) ? JSON.stringify(current) : 'null';
      case 'boolean':
        return current ? 'true' : 'false';
      case 'bigint':
        throw new TypeError('stableStringify cannot serialize a bigint');
      case 'undefined':
      case 'function':
      case 'symbol':
        return inArray ? 'null' : undefined;
      default:
        break;
    }
    const object = current as object;
    if (seen.has(object)) throw new TypeError('stableStringify cannot serialize a cycle');
    seen.add(object);
    try {
      if (Array.isArray(object)) return `[${object.map((entry) => write(entry, true) ?? 'null').join(',')}]`;
      const entries = Object.keys(object).sort().flatMap((key) => {
        const encoded = write((object as Record<string, unknown>)[key], false);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      });
      return `{${entries.join(',')}}`;
    } finally {
      seen.delete(object);
    }
  };
  return write(value, false) ?? 'null';
}

/** The first 16 hex characters of the SHA-256 of stableStringify(value). */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

export interface ObservationChange {
  previous: CompanionSnapshotRecord;
  current: Observation;
}

export interface ObservationDiff {
  /** Objects not seen before. */
  added: Observation[];
  /** Objects whose fingerprint changed. */
  changed: ObservationChange[];
  /** Objects the source no longer reports. */
  removed: CompanionSnapshotRecord[];
  /** Objects whose fingerprint stayed the same. */
  unchanged: ObservationChange[];
  /**
   * The snapshots to store for this poll, one per current observation:
   * firstSeenAt kept, fingerprintSince kept while the fingerprint holds (else
   * the observation's time), lastSeenAt and state from this poll. Removed
   * objects are not in it (repository.applySourcePoll counts their misses
   * and forgets them after the second, recordMissingSnapshots).
   */
  snapshots: CompanionSnapshotRecord[];
}

/**
 * Compares one source's poll with its stored snapshots. Every observation
 * must belong to one source and name each object once: a source reporting
 * an object twice is a bug, and the poll should fail rather than store it.
 */
export function diffObservations(previous: ReadonlyMap<string, CompanionSnapshotRecord>, current: readonly Observation[]): ObservationDiff {
  const diff: ObservationDiff = { added: [], changed: [], removed: [], unchanged: [], snapshots: [] };
  const keys = new Set<string>();
  const source = current[0]?.source;
  for (const observation of current) {
    if (observation.source !== source) throw new Error(`one poll mixes sources ${source} and ${observation.source}`);
    if (keys.has(observation.objectKey)) throw new Error(`source ${source} reported ${observation.objectKey} twice`);
    keys.add(observation.objectKey);
    const before = previous.get(observation.objectKey);
    if (before && before.source !== observation.source) throw new Error(`snapshot ${observation.objectKey} belongs to source ${before.source}`);
    const same = before?.fingerprint === observation.fingerprint;
    if (!before) diff.added.push(observation);
    else if (same) diff.unchanged.push({ previous: before, current: observation });
    else diff.changed.push({ previous: before, current: observation });
    diff.snapshots.push({
      source: observation.source,
      objectKey: observation.objectKey,
      fingerprint: observation.fingerprint,
      state: observation.state,
      firstSeenAt: before?.firstSeenAt ?? observation.observedAt,
      fingerprintSince: before && same ? before.fingerprintSince : observation.observedAt,
      lastSeenAt: observation.observedAt,
    });
  }
  for (const [key, before] of previous) {
    if (!keys.has(key)) diff.removed.push(before);
  }
  return diff;
}
