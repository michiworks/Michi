import { log } from '../logger';
import { syncSkillMounts } from './mounts';

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * Called after the library or its settings change. Runtimes that hold live
 * sessions subscribe to refresh them (Claude reloadSkills, Codex extra roots).
 */
export function onSkillLibraryChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Update the mounts first, so a listener that reloads a runtime sees the new links. */
export function notifySkillLibraryChanged(): void {
  syncSkillMounts();
  for (const listener of [...listeners]) {
    try { listener(); }
    catch (error) { log.warn('workspace', 'skill library change listener failed', { error: (error as Error).message }); }
  }
}
