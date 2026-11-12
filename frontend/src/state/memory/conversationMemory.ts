import { useCallback, useEffect, useState } from 'react';
import type { ConversationMemoryMode } from 'michi-shared';
import {
  fetchConversationMemoryMode,
  fetchMemorySettings,
  isMemoryNotFound,
  saveConversationMemoryMode,
  type ConversationMemoryChange,
} from '../../services/api/memories';

/**
 * A conversation's memory setting (GET/PUT /api/nodes/:nodeId/memory-mode on
 * the backend holding the conversation): learn, use only or off. The control
 * in a chat's composer shows it while memory is on at that backend; with
 * memory off for every chat there is nothing to choose here.
 */

/** Panes that open together ask their backend once whether memory is on. */
const SETTINGS_READ_MS = 5_000;
/** A chat opened a moment ago reaches its backend with the next workspace sync (every 2 s). */
const NEW_CHAT_RETRIES = 3;
const NEW_CHAT_RETRY_MS = 1_500;

const settingsReads = new Map<string, { at: number; read: Promise<boolean> }>();
const memoryOnListeners = new Set<(apiBase: string, on: boolean) => void>();
const modeListeners = new Set<(apiBase: string, nodeId: string, mode: ConversationMemoryMode) => void>();

function readMemoryOn(apiBase: string): Promise<boolean> {
  const now = Date.now();
  const cached = settingsReads.get(apiBase);
  if (cached && now - cached.at < SETTINGS_READ_MS) return cached.read;
  const read = fetchMemorySettings(undefined, apiBase).then((settings) => settings.mode !== 'off');
  settingsReads.set(apiBase, { at: now, read });
  read.catch(() => { if (settingsReads.get(apiBase)?.read === read) settingsReads.delete(apiBase); });
  return read;
}

/** Settings › Memory turned memory on or off at this backend: every chat's control there follows. */
export function noteMemoryOn(apiBase: string, on: boolean): void {
  settingsReads.set(apiBase, { at: Date.now(), read: Promise.resolve(on) });
  for (const listener of [...memoryOnListeners]) listener(apiBase, on);
}

/** Calls `listener` whenever Settings › Memory turns memory on or off at a backend (noteMemoryOn). Returns unsubscribe. */
export function onMemoryOnChange(listener: (apiBase: string, on: boolean) => void): () => void {
  memoryOnListeners.add(listener);
  return () => { memoryOnListeners.delete(listener); };
}

/** Calls `listener` after a chat's memory setting was saved (what its replies were based on may show differently). Returns unsubscribe. */
export function onConversationMemoryModeChange(listener: (apiBase: string, nodeId: string, mode: ConversationMemoryMode) => void): () => void {
  modeListeners.add(listener);
  return () => { modeListeners.delete(listener); };
}

async function saveMode(apiBase: string, nodeId: string, mode: ConversationMemoryMode): Promise<ConversationMemoryChange> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await saveConversationMemoryMode(apiBase, nodeId, mode);
    } catch (error) {
      if (!isMemoryNotFound(error) || attempt >= NEW_CHAT_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, NEW_CHAT_RETRY_MS));
    }
  }
}

export interface ConversationMemory {
  /** The chat's setting; null while it loads, on a backend without it, or while memory is off there. */
  mode: ConversationMemoryMode | null;
  saving: boolean;
  /** Rejects when the backend refused or could not be reached; the setting shown stays as it was. */
  setMode: (mode: ConversationMemoryMode) => Promise<ConversationMemoryChange>;
}

export function useConversationMemory(apiBase: string, nodeId: string): ConversationMemory {
  const key = `${apiBase}\n${nodeId}`;
  const [loaded, setLoaded] = useState<{ key: string; mode: ConversationMemoryMode | null; memoryOn: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      // A chat its backend has not stored yet (just opened) learns, as every new chat does.
      fetchConversationMemoryMode(apiBase, nodeId, controller.signal)
        .catch((error: unknown) => { if (isMemoryNotFound(error)) return 'learn' as const; throw error; }),
      readMemoryOn(apiBase),
    ]).then(([mode, memoryOn]) => {
      if (!controller.signal.aborted) setLoaded({ key, mode, memoryOn });
    }, () => {
      // An older backend, or one that could not be read: no control.
      if (!controller.signal.aborted) setLoaded({ key, mode: null, memoryOn: false });
    });
    return () => controller.abort();
  }, [apiBase, nodeId, key]);

  useEffect(() => {
    const follow = (base: string, on: boolean) => {
      if (base === apiBase) setLoaded((current) => current && current.key === key ? { ...current, memoryOn: on } : current);
    };
    memoryOnListeners.add(follow);
    return () => { memoryOnListeners.delete(follow); };
  }, [apiBase, key]);

  const setMode = useCallback(async (mode: ConversationMemoryMode) => {
    setSaving(true);
    try {
      const change = await saveMode(apiBase, nodeId, mode);
      setLoaded((current) => current && current.key === key ? { ...current, mode: change.mode } : current);
      for (const listener of [...modeListeners]) {
        try { listener(apiBase, nodeId, change.mode); } catch { /* a listener never fails the save */ }
      }
      return change;
    } finally {
      setSaving(false);
    }
  }, [apiBase, nodeId, key]);

  const current = loaded?.key === key ? loaded : null;
  return { mode: current?.memoryOn ? current.mode : null, saving, setMode };
}

/**
 * Forget what was read between test cases.
 * @testonly
 */
export function resetConversationMemory(): void {
  settingsReads.clear();
}
