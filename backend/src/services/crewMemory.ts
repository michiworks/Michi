import { isCrewMemoryMode, type CrewMemoryMode } from 'michi-shared';
import { getDb } from './db';
import { isTemporaryChat, isTemporaryMemoryMode } from './memory/temporaryChat';

// Michi's Crew memory preferences: the user's default mode and each chat's
// pinned mode (RuntimeHost.bindings.crewMemory, and the /crew/memory routes).

function key(userId?: string | null): string {
    if (process.env.MICHI_CLOUD === '1') {
        if (!userId) throw new Error('Crew preferences require an authenticated owner');
        return `crew_memory:user:${userId}`;
    }
    return 'crew_memory:desktop';
}

/**
 * The mode a new Crew chat starts with: the user's saved choice, else
 * MICHI_CREW_MEMORY_MODE, else Read only ('incognito'). Michi Memory is the
 * one store that learns from Michi's chats, so by default Crew recalls what
 * its own memory already holds and writes nothing new to it.
 */
export function defaultCrewMemory(userId?: string | null): CrewMemoryMode {
    const row = getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key(userId)) as { value: string } | undefined;
    if (isCrewMemoryMode(row?.value)) return row.value;
    const env = process.env.MICHI_CREW_MEMORY_MODE;
    return isCrewMemoryMode(env) ? env : 'incognito';
}

export function saveDefaultCrewMemory(mode: CrewMemoryMode, userId?: string | null): void {
    if (!isCrewMemoryMode(mode)) throw new Error('Invalid Crew memory mode');
    getDb().prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key(userId), mode);
}

/**
 * The Crew memory mode a new session of the node starts with: Off
 * ('temporary') for a temporary chat (memory/temporaryChat.ts), whatever was
 * asked for; else `requested` (none: the chat's pinned mode, else the default).
 */
export function crewMemoryModeFor(nodeId: string, requested: CrewMemoryMode | undefined): CrewMemoryMode | undefined {
    return isTemporaryChat(nodeId) ? 'temporary' : requested;
}

/**
 * The node as the Crew adapter reads it (RuntimeHost.bindings.nodeBinding): a
 * temporary chat's pinned mode reads as 'temporary', so every new Crew session
 * of it is, from any path that names no mode (restore, spawn_branches).
 */
export function withTemporaryCrewMemory<T extends { memory_mode?: string | null; crew_memory_mode?: string | null }>(node: T | null): T | null {
    return node && isTemporaryMemoryMode(node.memory_mode) ? { ...node, crew_memory_mode: 'temporary' } : node;
}

/** Called only after the node's owner has been verified by session setup. */
export function pinCrewMemory(nodeId: string, mode: CrewMemoryMode): void {
    if (!isCrewMemoryMode(mode)) throw new Error('Invalid Crew memory mode');
    getDb().prepare('UPDATE nodes SET crew_memory_mode = ? WHERE id = ? AND (crew_memory_mode IS NULL OR crew_memory_mode != ?)').run(mode, nodeId, mode);
}
