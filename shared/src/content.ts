/** Shared presentation contracts for Michi's built-in content UI. */
export type MichiThreadState = 'waiting' | 'stalled' | 'doing' | 'done' | 'idea';

/** Optional state metadata for a database row. */
export interface DatabaseRowStatus {
  state: MichiThreadState;
  doneBy?: 'user' | 'agent';
}

/** Renderer input; native Pages validates persisted blocks against its catalog. */
export interface MichiPageBlock {
  type: string;
  id?: string;
  [field: string]: unknown;
}

/** Quoted interface material handed to the Michi assistant. */
export interface MichiContextItem {
  /**
   * `companion_item` (DESIGN-v2 §1.2, §1.3): a Today item the user asks the
   * agent about (Today's Ask): `id` is the item's id, `title` its title. The
   * message also carries `{kind: 'companion_item', itemId}` in
   * metaAgentContext.refs, so its turn starts with collector material and
   * runs in Ask (§2.8 T4). W2-F1a attaches and shows it.
   */
  kind: 'thread' | 'block' | 'row' | 'node' | 'companion_item';
  id: string;
  title: string;
  text?: string;
  projectId?: string;
}
