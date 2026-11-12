export const PAGE_TOOL_NAMES = [
  'read_home',
  'edit_home',
  'list_pages',
  'read_page',
  'preview_page',
  'edit_page',
  'create_page',
  'create_database',
  'configure_database',
  'read_database',
  'edit_database',
  'list_page_components',
  'read_page_component',
  'save_page_component',
  'configure_database_view',
  'open_task_database',
  'list_tasks',
] as const;

export type PageToolName = typeof PAGE_TOOL_NAMES[number];

export interface ActivePageTurnAttribution {
  turnId: string;
  assistantId: string;
  /**
   * The session the turn runs on may approve the turn's later tools on its
   * own (Kiro's Approve for me, McpSlot.getActivePageTurnAttribution), so a
   * taint recorded mid-turn would not make it ask: page tools hand such a
   * turn what a check-in wrote as stubs (pageTools.ts markedRead).
   */
  approveForMe?: true;
}

export type ActivePageTurnAttributionGetter = () => ActivePageTurnAttribution | null;
