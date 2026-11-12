/** Names of the Michi Memory agent tools; kept dependency-free for the tool catalog and permission policy. */
export const MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_save",
  "memory_update",
  "memory_delete",
] as const;

export type MemoryToolName = typeof MEMORY_TOOL_NAMES[number];

export function isMemoryToolName(name: string): name is MemoryToolName {
  return (MEMORY_TOOL_NAMES as readonly string[]).includes(name);
}

/** What a tool chip calls each one (Pi's tools, the assistant's catalog). */
export const MEMORY_TOOL_LABELS: Readonly<Record<MemoryToolName, string>> = Object.freeze({
  memory_search: "Search memory",
  memory_save: "Save memory",
  memory_update: "Correct memory",
  memory_delete: "Delete memory",
});
