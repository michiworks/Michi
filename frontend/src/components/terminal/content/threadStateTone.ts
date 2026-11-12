import type { MichiThreadState } from 'michi-shared';

/** Each thread state's colour, as its state dot draws it; other marks of a state take theirs from here. */
export const THREAD_STATE_TONE: Record<MichiThreadState, string> = {
  waiting: 'var(--term-waiting)',
  doing: 'var(--term-mid)',
  stalled: 'var(--term-mauve)',
  done: 'var(--term-digest)',
  idea: 'var(--term-faint)',
};
