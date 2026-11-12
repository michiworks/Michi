import type { SessionMode } from '../services/api';
import { buildSlashEntries, type SlashEntry } from '../state/slashEntries';

/** One entry in the autocomplete list. */
export interface SlashItem extends Omit<SlashEntry, 'source'> {
  /** SlashEntry's sources, plus 'agent': an agent/mode pick surfaced under /agent. */
  source: SlashEntry['source'] | 'agent';
  /** Only set for source='agent' — the ACP modeId to pass to session/set_mode. */
  modeId?: string;
}

const LOCAL_ONLY = buildSlashEntries({});

/** Does the current input put us "in a slash command"? Matches `/…` at the
 *  very start of the value, before any whitespace or newline. Returns the
 *  query (text after the slash) or null. Only triggers at position 0 so
 *  mid-paragraph slashes (like URLs) don't pop the menu. */
export function matchSlashContext(
  value: string,
  selectionStart: number | null,
): { query: string; command?: string } | null {
  if (!value.startsWith('/')) return null;
  // Pass 1: bare slash command being typed (no args yet). Names may be
  // qualified (`plugin:skill`).
  const head = value.match(/^\/([\w:-]*)$/);
  if (head) {
    if (selectionStart !== null && selectionStart > value.length) return null;
    return { query: head[1] };
  }
  // Pass 2: `/agent <query>` — second-level picker for agent/mode selection.
  // Only trigger for known sub-picker commands so normal slash-prefixed args
  // (e.g. `/branch foo bar`) still close the popup.
  const sub = value.match(/^\/(agent)\s+([\w-]*)$/);
  if (sub) {
    if (selectionStart !== null && selectionStart > value.length) return null;
    return { query: sub[2], command: sub[1] };
  }
  return null;
}

/** Build agent picker items from the global agent list + the node's current mode. */
export function buildAgentItems(
  availableModes: SessionMode[] | undefined,
  currentModeId: string | null | undefined,
  query: string,
): SlashItem[] {
  if (!availableModes || availableModes.length === 0) return [];
  const q = query.toLowerCase();
  const items: SlashItem[] = availableModes.map((m) => ({
    name: m.name,
    description:
      m.id === currentModeId
        ? `✓ current · ${(m.description ?? '').slice(0, 120)}`
        : (m.description ?? '').slice(0, 120),
    source: 'agent',
    takesArgs: false,
    modeId: m.id,
  }));
  if (!q) return items;
  const prefix: SlashItem[] = [];
  const rest: SlashItem[] = [];
  for (const it of items) {
    const lower = it.name.toLowerCase();
    if (lower.startsWith(q)) prefix.push(it);
    else if (lower.includes(q)) rest.push(it);
  }
  return [...prefix, ...rest];
}

/**
 * The chat's / entries (buildSlashEntries; without them, Michi's own
 * commands) whose names contain the query: those it names exactly first, so
 * Enter completes the name typed; then commands, then skills, each with the
 * names that start with the query before the ones that only contain it.
 * Within each, the entries keep their order (Michi's, then the runtime's;
 * library skills, then the runtime's).
 */
export function buildSlashItems(entries: readonly SlashEntry[] | undefined, query: string): SlashItem[] {
  const all = entries ?? LOCAL_ONLY;
  const q = query.toLowerCase();
  if (!q) return [...all];
  const exact: SlashItem[] = [];
  const groups = { command: { prefix: [] as SlashItem[], rest: [] as SlashItem[] }, skill: { prefix: [] as SlashItem[], rest: [] as SlashItem[] } };
  for (const it of all) {
    const lower = it.name.toLowerCase();
    const group = groups[it.source === 'skill' ? 'skill' : 'command'];
    if (lower === q) exact.push(it);
    else if (lower.startsWith(q)) group.prefix.push(it);
    else if (lower.includes(q)) group.rest.push(it);
  }
  return [...exact, ...groups.command.prefix, ...groups.command.rest, ...groups.skill.prefix, ...groups.skill.rest];
}
