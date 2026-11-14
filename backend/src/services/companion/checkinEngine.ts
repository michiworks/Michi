/**
 * Which engine starts check-ins (unification D11, P6): the Companion's own
 * coordinator (the default), or the scheduler's check-in lane
 * (checkinLane.ts). The `meta` key `companion:engine` holds the choice;
 * MICHI_CHECKIN_ENGINE overrides it. It is read on every tick, so a switch
 * applies from the next one, both ways; a check-in already running ends
 * where it started.
 */

import { getDb } from '../db';

export type CheckinEngine = 'coordinator' | 'scheduler';

const ENGINE_KEY = 'companion:engine';

function parsed(value: string | null | undefined): CheckinEngine | null {
  const text = value?.trim().toLowerCase();
  return text === 'coordinator' || text === 'scheduler' ? text : null;
}

/** The engine that starts check-ins now: the environment, else the stored key, else the coordinator. */
export function checkinEngine(env: NodeJS.ProcessEnv = process.env): CheckinEngine {
  const fromEnv = parsed(env.MICHI_CHECKIN_ENGINE);
  if (fromEnv) return fromEnv;
  const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(ENGINE_KEY) as { value: string } | undefined;
  return parsed(row?.value) ?? 'coordinator';
}
