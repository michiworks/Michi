import { toast } from 'sonner';

/**
 * The window's undo history for the user's own actions: archiving, moving,
 * renaming, closing a pane, editing a Page or a database. ⌘Z undoes the
 * newest entry, and an action's toast offers Undo for the same entry.
 *
 * Only the user's own actions go on it, never what an agent did: an agent's
 * change can land at any time, and ⌘Z must not undo something the user did
 * not just do. History lives for this window only; Trash and Archived keep
 * what can still be restored after a reload. There is no redo.
 */
export interface UndoEntry {
  readonly id: string;
  /** What the action did, in the past tense: `Archived “Plan”`. */
  readonly label: string;
  readonly at: number;
  /**
   * Reverses the action, reading current state rather than what the closure
   * saw. Returning false means it can no longer be reversed (what it would
   * restore is gone); a string says what kept it from being undone, in full
   * or in part; throwing means the reversal failed.
   */
  readonly undo: () => unknown;
  /** The toast that offers Undo for this entry, dismissed once it is used. */
  readonly toastId?: string | number;
}

export interface RecordUndoInput {
  label: string;
  undo: () => unknown;
  /** Shows the label in a toast with an Undo button: for actions that take something out of view. */
  toast?: boolean;
}

export type UndoOutcome = 'undone' | 'empty' | 'stale' | 'partial' | 'failed';

const LIMIT = 50;
let stack: UndoEntry[] = [];
let seq = 0;
/** While an undo runs, the actions it calls must not record their own entries. */
let replaying = 0;
/** Entries recorded inside collectUndo go to its list instead of the stack. */
let collecting: UndoEntry[] | null = null;

/** Records an action the user just did. Returns the entry's id, or null when it was not recorded. */
export function recordUndo(input: RecordUndoInput): string | null {
  if (replaying > 0) return null;
  const id = `undo-${++seq}`;
  const entry: UndoEntry = { id, label: input.label, at: Date.now(), undo: input.undo };
  if (collecting) {
    collecting.push(entry);
    return id;
  }
  const toastId = input.toast
    ? toast(input.label, { id, action: { label: 'Undo', onClick: () => { void undoEntry(id); } } })
    : undefined;
  stack = [...stack, toastId === undefined ? entry : { ...entry, toastId }].slice(-LIMIT);
  return id;
}

/**
 * Runs `fn`, keeping what its actions record off the stack, and returns
 * those entries so the caller can record one entry for all of them (a bulk
 * archive is one ⌘Z), or one with its own undo. Only what `fn` records
 * synchronously is caught.
 */
export function collectUndo<T>(fn: () => T): { result: T; entries: UndoEntry[] } {
  const outer = collecting;
  const entries: UndoEntry[] = [];
  collecting = entries;
  try {
    return { result: fn(), entries };
  } finally {
    collecting = outer;
  }
}

/** One undo for several collected entries, reversed newest first; false when none of them could be. */
export function undoAll(entries: readonly UndoEntry[]): () => Promise<boolean> {
  return async () => {
    let any = false;
    for (const entry of [...entries].reverse()) {
      if ((await entry.undo()) !== false) any = true;
    }
    return any;
  };
}

/** Records one entry for what `fn`'s actions record, when they record anything. */
export function recordUndoGroup<T>(fn: () => T, label: (count: number) => string, options?: { toast?: boolean }): T {
  const { result, entries } = collectUndo(fn);
  if (entries.length === 1) recordUndo({ label: entries[0].label, undo: entries[0].undo, toast: options?.toast });
  else if (entries.length > 1) recordUndo({ label: label(entries.length), undo: undoAll(entries), toast: options?.toast });
  return result;
}

/** When the newest entry was recorded, or null when there is nothing to undo. */
export function newestUndoAt(): number | null {
  return stack.length ? stack[stack.length - 1].at : null;
}

/** Undoes the newest entry and tells the user how it went. */
export function undoLatest(): Promise<UndoOutcome> {
  const entry = stack[stack.length - 1];
  if (!entry) return Promise.resolve('empty');
  return run(entry);
}

/** Undoes one entry, as its toast's Undo button does. */
export function undoEntry(id: string): Promise<UndoOutcome> {
  const entry = stack.find((candidate) => candidate.id === id);
  if (!entry) return Promise.resolve('empty');
  return run(entry);
}

async function run(entry: UndoEntry): Promise<UndoOutcome> {
  stack = stack.filter((candidate) => candidate.id !== entry.id);
  if (entry.toastId !== undefined) toast.dismiss(entry.toastId);
  replaying += 1;
  let result: unknown;
  try {
    result = await entry.undo();
  } catch (error) {
    console.warn('undo failed:', error);
    toast.error('Couldn’t undo that.', { description: entry.label });
    return 'failed';
  } finally {
    replaying -= 1;
  }
  if (result === false) {
    toast('Can’t undo that anymore.', { description: entry.label });
    return 'stale';
  }
  if (typeof result === 'string') {
    toast.error(result, { description: entry.label });
    return 'partial';
  }
  toast('Undone', { description: entry.label });
  return 'undone';
}

/** @testonly */
export function resetUndoStackForTests(): void {
  stack = [];
  seq = 0;
  replaying = 0;
  collecting = null;
}
