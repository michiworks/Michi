/**
 * Lean workspace metadata for remote connections.
 *
 * `GET /workspaces/all?meta=1&lean=1` leaves heavy per-node fields out of the
 * rows that hold a value, and names the fields it may leave out in the
 * response's top-level `leanNodeFields`. A row missing such a field defers it:
 * the window holds no value for it until a tree page brings it
 * (`pages[i].node`). A field a lean row keeps (null included) is the row's
 * value. A backend that predates this ignores `lean` and sends no marker, so
 * the window defers nothing.
 *
 * A window never writes a field it deferred: a write would replace the
 * backend's value with nothing. The backend's node upsert keeps a column
 * whose key a payload leaves out.
 */
export const LEAN_NODE_FIELDS = ['branch_overview', 'follow_ups', 'composer_draft'] as const;

export type LeanNodeField = (typeof LEAN_NODE_FIELDS)[number];

/** The node columns each lean field stands for; follow-ups carry their source message. */
export const LEAN_NODE_FIELD_COLUMNS: Readonly<Record<LeanNodeField, readonly string[]>> = {
  branch_overview: ['branch_overview'],
  follow_ups: ['follow_ups', 'follow_ups_source_message_id'],
  composer_draft: ['composer_draft'],
};

/** The lean fields a response names; anything else is ignored. */
export function parseLeanNodeFields(value: unknown): LeanNodeField[] {
  if (!Array.isArray(value)) return [];
  return LEAN_NODE_FIELDS.filter((field) => value.includes(field));
}
