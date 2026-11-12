export const NBSP = '\u00A0';
/** Sets the agent's own words apart from Michi's phrases in a sentence. */
export const SAID_SEP = `${NBSP}· `;

/** The verbs Michi's own phrases say (commandPhrase, michiToolCopy) and their past: a step names
 *  the base form ("Merge origin/dev"), a run's sentence the past ("Merged origin/dev"). */
export const VERB_PAST = {
  ask: 'asked', build: 'built', cancel: 'cancelled', check: 'checked', commit: 'committed', configure: 'configured',
  create: 'created', delete: 'deleted', edit: 'edited', 'fast-forward': 'fast-forwarded', fetch: 'fetched',
  inspect: 'inspected', install: 'installed', lint: 'linted', list: 'listed', load: 'loaded', merge: 'merged',
  open: 'opened', pull: 'pulled', push: 'pushed', read: 'read', rebase: 'rebased', remove: 'removed',
  report: 'reported', review: 'reviewed', route: 'routed', run: 'ran', save: 'saved', search: 'searched',
  send: 'sent', show: 'showed', stage: 'staged', start: 'started', stash: 'stashed', stop: 'stopped',
  switch: 'switched', typecheck: 'typechecked', update: 'updated', view: 'viewed', wait: 'waited', watch: 'watched',
} as const satisfies Record<string, string>;
export type PhraseVerb = keyof typeof VERB_PAST;

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Lowercases a sentence-case first letter only ("Read x" → "read x", "E2E" stays). */
export const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
