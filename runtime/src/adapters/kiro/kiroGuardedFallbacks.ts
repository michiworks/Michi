/**
 * The agent a Kiro chat left for a guarded turn's fallback (lane D, user
 * decision 2026-11-12). Kiro V3's bundled modes have no agent file (autonomous,
 * for one), so Michi cannot make a copy Kiro lists: a guarded turn runs on
 * vibe instead, which asks before commands and writes, and the chat's next
 * unguarded turn goes back to the mode it left. That mode is kept here, by
 * native session id, in a file under the host's data directory, so a restart
 * between the two turns does not lose it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from '../../core/atomicFile';

/** v3's bundled mode a guarded turn falls back to: probed on kiro-cli 3.2.1 to ask before a command and a file write. */
export const KIRO_GUARDED_FALLBACK_AGENT = 'vibe';

const FILE = 'kiro-guarded-fallbacks.json';
/** Sessions remembered at once; the oldest go first. */
const MAX_ENTRIES = 500;

interface Entry { base: string | null; at: number }
type Store = Record<string, Entry>;

export interface KiroGuardedFallbacks {
  /** The mode the session left for the fallback (null: Kiro's default); undefined when it did not. */
  get(nativeSessionId: string): { base: string | null } | undefined;
  /** Remembers it. Throws when it cannot: the turn then does not switch. */
  set(nativeSessionId: string, base: string | null, now?: number): void;
  /** Forgets it. Never throws: a record that stays sends a later unguarded turn back once more. */
  delete(nativeSessionId: string): void;
}

function validEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { base?: unknown; at?: unknown };
  return (typeof entry.base === 'string' || entry.base === null) && typeof entry.at === 'number';
}

/** The store under `dataDir()`, read on every call (several runtimes of one host share the file). */
export function kiroGuardedFallbacks(dataDir: () => string): KiroGuardedFallbacks {
  const file = () => path.join(dataDir(), FILE);
  const read = (): Store => {
    let parsed: unknown;
    try { parsed = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, entry]) => validEntry(entry))) as Store;
  };
  const write = (store: Store) => {
    fs.mkdirSync(dataDir(), { recursive: true });
    writeFileAtomicSync(file(), `${JSON.stringify(store)}\n`);
  };
  return {
    get(nativeSessionId) {
      const entry = read()[nativeSessionId];
      return entry ? { base: entry.base } : undefined;
    },
    set(nativeSessionId, base, now = Date.now()) {
      const store = read();
      store[nativeSessionId] = { base, at: now };
      const ids = Object.keys(store).sort((a, b) => store[a].at - store[b].at);
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES))) delete store[id];
      write(store);
    },
    delete(nativeSessionId) {
      try {
        const store = read();
        if (!(nativeSessionId in store)) return;
        delete store[nativeSessionId];
        write(store);
      } catch { /* kept: the next unguarded turn goes back again, which changes nothing */ }
    },
  };
}
