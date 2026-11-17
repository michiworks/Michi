import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronRightIcon } from '../../icons';
import type { MemoryGuess } from 'michi-shared';
import { onMemoryChanged, runSelfCreate } from '../../../../state/memory/memoryNotifications';
import { confirmMemoryGuess, fetchMemoryGuesses, isMemoryNotFound, rejectMemoryGuess } from '../../../../services/api/memories';
import { Button } from '../../../ui/controls';
import { SettingsSection } from './SettingsSection';

/**
 * Settings › Memory › Guesses: patterns Michi noticed across the user's
 * memories (GET /api/memory-guesses), which agents never use until the user
 * confirms one. Collapsed, shown only while there is a guess, with no count:
 * nothing here asks for the user's attention. That's right saves the guess as
 * a memory of the user's; Not true drops it for good.
 */

const RELOAD_DEBOUNCE_MS = 250;

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'unknown error';
}

export function MemoryGuesses({ memoryOn, reloadKey, onConfirmed }: {
  memoryOn: boolean;
  /** Changes when every memory was deleted: the guesses are read again. */
  reloadKey: number;
  /** A guess became a memory of the user's. */
  onConfirmed?: () => void;
}) {
  const [guesses, setGuesses] = useState<MemoryGuess[]>([]);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await fetchMemoryGuesses();
      if (mine === generation.current) setGuesses(next);
    } catch {
      // Guesses are optional: a failed read leaves what was shown.
    }
  }, []);
  useEffect(() => { void load(); }, [load, reloadKey]);

  // A memory a guess rests on may change or go anywhere.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = onMemoryChanged(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void load(); }, RELOAD_DEBOUNCE_MS);
    });
    return () => { stop(); if (timer !== null) clearTimeout(timer); };
  }, [load]);

  const settled = (id: string) => {
    generation.current += 1;
    setGuesses((current) => current.filter((guess) => guess.id !== id));
  };

  if (guesses.length === 0) return null;
  return (
    <SettingsSection title="Guesses" className="memory-guesses"
      intro="Patterns Michi noticed across your memories. Agents don’t use a guess unless you confirm it.">
      <button type="button" className="memory-guesses__toggle" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}>
        <ChevronRightIcon size="sm" />
        {open ? 'Hide guesses' : 'Show guesses'}
      </button>
      {open && (
        <ul id={listId} className="memory-guesses__list" aria-label="Guesses">
          {guesses.map((guess) => (
            <GuessItem key={guess.id} guess={guess} memoryOn={memoryOn} onStale={() => { void load(); }}
              onSettled={(confirmed) => { settled(guess.id); if (confirmed) onConfirmed?.(); }} />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function GuessItem({ guess, memoryOn, onSettled, onStale }: {
  guess: MemoryGuess;
  memoryOn: boolean;
  /** Answered: confirmed (true) or rejected. */
  onSettled: (confirmed: boolean) => void;
  /** The guess no longer applies (its memories changed, or it was answered elsewhere). */
  onStale: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = async (right: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (right) await runSelfCreate(() => confirmMemoryGuess(guess.id));
      else await rejectMemoryGuess(guess.id);
      onSettled(right);
    } catch (failure) {
      setBusy(false);
      const code = (failure as { code?: string | null })?.code;
      if (isMemoryNotFound(failure) || code === 'invalid_state') {
        setError('This guess no longer applies.');
        onStale();
      } else if (code === 'memory_disabled') {
        setError('Memory is off. Turn it on to save this guess.');
      } else {
        setError(`Couldn’t save your answer: ${errorText(failure)}`);
      }
    }
  };

  return (
    <li className="memory-guesses__item" aria-busy={busy || undefined}>
      <p className="memory-guesses__text">{guess.body}</p>
      {guess.cites.length > 0 && (
        <ul className="memory-guesses__cites" aria-label="Memories it’s based on">
          {guess.cites.map((cite) => <li key={cite.ref}>{cite.body}</li>)}
        </ul>
      )}
      <div className="memory-guesses__actions">
        <Button size="sm" variant="primary" disabled={busy || !memoryOn} onClick={() => { void answer(true); }}>That’s right</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void answer(false); }}>Not true</Button>
      </div>
      {error && <p className="memory-guesses__error" role="alert">{error}</p>}
    </li>
  );
}
