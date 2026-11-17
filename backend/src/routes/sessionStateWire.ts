import type { AgentCommand, AgentSessionState } from 'michi-shared';

/**
 * A session's state as the background feed sends it (11-09 performance
 * audit P0-4 step 1). A Claude session lists every skill with its
 * description, about 47 KB a frame, and the feed writes a frame for every
 * session the moment a window subscribes: 613 KB for 13 sessions, in the
 * same tick as the turn replay. The / menu takes skill descriptions from
 * /skills/catalog and lists no prompts (frontend slashEntries), so prompts
 * are left out and skills go without descriptions; a skill the catalog
 * lacks (a Kiro power) is listed without one. Commands go as they are.
 * `commands` is kept whenever the session reports it, an empty list (a
 * restricted session's) included: a window replaces its menu with it.
 * In-process subscribers keep the whole state.
 */
export function sessionStateForFeed(state: AgentSessionState): AgentSessionState {
  if (!state.commands) return state;
  return { ...state, commands: state.commands.flatMap(feedCommand) };
}

function feedCommand(command: AgentCommand): AgentCommand[] {
  if (command.kind === 'prompt') return [];
  if (command.kind !== 'skill' || command.description === undefined) return [command];
  const withoutDescription = { ...command };
  delete withoutDescription.description;
  return [withoutDescription];
}
