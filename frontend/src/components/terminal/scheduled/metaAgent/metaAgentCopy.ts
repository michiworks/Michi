/** The headline of each state that stops or holds Pages upkeep, for Settings › <name> › Pages upkeep: the same words as Pages and its sidebar. */
export { UPKEEP_HEADLINE } from '../../../../state/metaAgent/metaAgentStatus';

/** "<name> · Pages upkeep": the background maintenance, as the rail and toasts name it (DESIGN-v2 §1.5). */
export function pagesUpkeepTitle(name: string): string {
  return `${name} · Pages upkeep`;
}
